import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': '*', 
};

serve(async (req) => {
  // Tangani Preflight (PENTING!)
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { nominal, action, order_id } = body;

    // Koneksi Supabase
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    // MENDETEKSI GATEWAY OTOMATIS: Ambil kunci terbaru (Midtrans ATAU Xendit)
    const { data: keyData, error: dbError } = await supabase
      .from('payment_keys')
      .select('api_key, type')
      .in('type', ['Midtrans', 'Xendit'])
      .order('updated_at', { ascending: false })
      .limit(1)
      .single();

    if (dbError || !keyData) {
      throw new Error("Kunci pembayaran tidak ditemukan di database.");
    }

    const serverKey = keyData.api_key;
    const gatewayName = keyData.type; // Berisi 'Midtrans' atau 'Xendit'
    const authString = btoa(`${serverKey}:`);

    // ==========================================
    // LOGIKA 1: JIKA GATEWAY ADALAH XENDIT
    // ==========================================
    if (gatewayName === 'Xendit') {
      
      // -- A. Cek Status Pembayaran (Xendit) --
      if (action === 'check_status') {
        try {
          // Xendit butuh 2 langkah: Ambil ID QR, lalu cek apakah ada pembayaran di QR tersebut
          const qrRes = await fetch(`https://api.xendit.co/qr_codes/${order_id}`, {
            headers: { "Authorization": `Basic ${authString}` }
          });
          const qrData = await qrRes.json();
          
          let isPaid = false;
          if (qrData && qrData.id) {
            const payRes = await fetch(`https://api.xendit.co/qr_codes/${qrData.id}/payments`, {
              headers: { "Authorization": `Basic ${authString}` }
            });
            const payData = await payRes.json();
            const payments = payData.data || payData;
            
            if (Array.isArray(payments) && payments.length > 0) {
              isPaid = payments.some((p: any) => p.status === 'COMPLETED' || p.status === 'SUCCEEDED');
            }
          }
          
          return new Response(JSON.stringify({ 
            sukses: true, 
            payment_status: isPaid ? 'SUCCESS' : 'PENDING' 
          }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        } catch (err) {
          // Jika gagal ngecek, biarkan tetap PENDING agar tidak crash
          return new Response(JSON.stringify({ sukses: true, payment_status: 'PENDING' }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      }

      // -- B. Generate QRIS (Xendit) --
      const xenditRes = await fetch("https://api.xendit.co/qr_codes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Basic ${authString}`,
          "api-version": "2022-07-31" // Wajib untuk API Xendit terbaru
        },
        body: JSON.stringify({
          reference_id: order_id,
          type: "DYNAMIC",
          currency: "IDR",
          amount: nominal
        })
      });

      const xenditData = await xenditRes.json();

      if (!xenditRes.ok) {
         throw new Error(`Xendit Error: ${xenditData.message || "Gagal membuat QRIS"}`);
      }

      return new Response(
        JSON.stringify({ 
          sukses: true, 
          qris_string: xenditData.qr_string, // Frontend langsung membaca ini dan merender QR Code!
          data_gateway: xenditData 
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ==========================================
    // LOGIKA 2: JIKA GATEWAY ADALAH MIDTRANS
    // ==========================================
    if (gatewayName === 'Midtrans') {
      
      // -- A. Cek Status Pembayaran (Midtrans) --
      if (action === 'check_status') {
        const res = await fetch(`https://api.midtrans.com/v2/${order_id}/status`, {
          headers: { "Authorization": `Basic ${authString}` }
        });
        const statusData = await res.json();
        return new Response(JSON.stringify({ 
          sukses: true, 
          payment_status: (statusData.transaction_status === 'settlement' || statusData.transaction_status === 'capture') ? 'SUCCESS' : 'PENDING',
          gateway_response: statusData
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // -- B. Generate QRIS (Midtrans) --
      const midtransRes = await fetch("https://api.midtrans.com/v2/charge", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Basic ${authString}`
        },
        body: JSON.stringify({
          payment_type: "qris",
          transaction_details: { order_id: order_id, gross_amount: nominal }
        })
      });

      const midtransData = await midtransRes.json();

      if (midtransData.status_code !== "201" && midtransData.status_code !== "200") {
         throw new Error(midtransData.status_message || "Gagal membuat QRIS dari Midtrans");
      }

      return new Response(
        JSON.stringify({ sukses: true, data_midtrans: midtransData }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

  } catch (error) {
    return new Response(
      JSON.stringify({ sukses: false, pesan: error.message }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
