// supabase/functions/create-qris-payment/index.ts

import { createClient } from '@supabase/supabase-js';

// Inisialisasi Supabase Client
const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const supabaseClient = createClient(supabaseUrl, supabaseServiceKey);

// CORS Headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-application-name',
};

// -------------------------------------------------------------------------
// MAIN HANDLER EDGE FUNCTION
// -------------------------------------------------------------------------
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { order_id, amount, kiosk_id, action = 'create' } = await req.json();

    // 1. Ambil Config dari Database
    const { data: kiosk, error: kioskError } = await supabaseClient
      .from('kiosks')
      .select('payment_keys ( name, type, api_key )')
      .eq('id', kiosk_id)
      .maybeSingle();

    // Tips Tambahan: Munculkan log error asli dari Supabase agar mudah dilacak
    if (kioskError) {
      console.error("DB Fetch Error:", kioskError.message);
      throw new Error(`Gagal mengambil data dari database: ${kioskError.message}`);
    }
    if (!kiosk?.payment_keys) {
      throw new Error(`Kiosk "${kiosk_id}" belum memiliki konfigurasi pembayaran.`);
    }
    
    const pKey = Array.isArray(kiosk.payment_keys) ? kiosk.payment_keys[0] : kiosk.payment_keys;
    if (!pKey || !pKey.type) throw new Error(`Kiosk ini belum dihubungkan ke API Key Bank.`);

    const gatewayType = pKey.type.toLowerCase().trim();
    const apiKey = (pKey.api_key || '').replace(/['"]/g, '').trim();
    
    // Secara default anggap saja Production / false
    const isSandbox = false;

    console.log(`🚀 Gateway: ${gatewayType.toUpperCase()} | Action: ${action}`);

    let result: any = null;
    let paymentStatus = 'PENDING';
    let gatewayResponse = null;

    // =========================================================================
    // MODE: CHECK STATUS
    // =========================================================================
    if (action === 'check_status') {
      if (gatewayType === 'midtrans') {
        const isProd = !apiKey.toUpperCase().startsWith('SB-MID');
        const baseUrl = isProd ? `https://api.midtrans.com/v2/${order_id}/status` : `https://api.sandbox.midtrans.com/v2/${order_id}/status`;
        const response = await fetch(baseUrl, { headers: { 'Content-Type': 'application/json', 'Authorization': 'Basic ' + btoa(apiKey + ':') }});
        const data = await response.json();
        if (response.ok && (data.transaction_status === 'settlement' || data.transaction_status === 'capture')) paymentStatus = 'SUCCESS';
        gatewayResponse = data;
      }

      // Update Database
      if (paymentStatus === 'SUCCESS') {
        await supabaseClient.from('transactions').update({ payment_status: 'SUCCESS', paid_at: new Date().toISOString() }).eq('order_id', order_id);
      } else if (paymentStatus === 'FAILED') {
        await supabaseClient.from('transactions').update({ payment_status: 'FAILED' }).eq('order_id', order_id);
      }

      return new Response(JSON.stringify({ payment_status: paymentStatus, gateway_response: gatewayResponse }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // =========================================================================
    // MODE: CREATE TRANSACTION
    // =========================================================================
    switch (gatewayType) {
      
      // --- MIDTRANS ---
      case 'midtrans': {
        const isProd = !apiKey.toUpperCase().startsWith('SB-MID');
        const baseUrl = isProd ? 'https://api.midtrans.com/v2/charge' : 'https://api.sandbox.midtrans.com/v2/charge';
        const response = await fetch(baseUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Basic " + btoa(apiKey + ":") },
          body: JSON.stringify({ payment_type: "qris", transaction_details: { order_id: order_id.toString(), gross_amount: Math.round(amount) } })
        });
        result = await response.json();
        if (!response.ok) throw new Error(result.status_message || 'Midtrans Error');
        
        // Biarkan result.qr_string apa adanya (berisi raw string 000201...). Jangan ditimpa dengan URL gambar.
        break;
      }

      // --- XENDIT ---
      case 'xendit': {
        if (!apiKey) throw new Error('Xendit: Secret API Key kosong.');
        const response = await fetch('https://api.xendit.co/qr_codes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${btoa(apiKey + ':')}`, 'api-version': '2022-07-31' },
          body: JSON.stringify({ external_id: order_id.toString(), amount: Math.round(amount), type: 'DYNAMIC' })
        });
        result = await response.json();
        if (!response.ok) throw new Error(result.message || 'Xendit API Error');
        break;
      }

      default:
        throw new Error(`Gateway "${gatewayType}" tidak didukung.`);
    }

    // Kembalikan Response Akhir
    const isCheckoutUrl = result.qr_string?.startsWith('http');
    const finalResponse = {
      gateway: gatewayType,
      type: isCheckoutUrl ? 'CHECKOUT_URL' : 'QRIS_STRING',
      payload: result?.qr_string || result?.token || result?.qr_code || null,
      raw: result,
    };

    return new Response(JSON.stringify(finalResponse), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (err: any) {
    console.error("💥 ERROR EDGE FUNCTION:", err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
