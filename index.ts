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
    return new Response(null, { 
      status: 204, 
      headers: corsHeaders 
    });
  }

  try {
    const body = await req.json();
    const { nominal, action, order_id } = body;

    // Koneksi Supabase
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const { data: keyData } = await supabase
      .from('payment_keys')
      .select('api_key')
      .eq('type', 'Midtrans')
      .single();

    const serverKey = keyData?.api_key;
    const authString = btoa(`${serverKey}:`);

    // LOGIKA: CEK STATUS (Untuk tombol Manual Check - VERSI PRODUCTION)
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

    // LOGIKA: GENERATE QRIS (VERSI PRODUCTION)
    const midtransRes = await fetch("https://api.midtrans.com/v2/charge", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${authString}`
      },
      body: JSON.stringify({
        payment_type: "qris",
        transaction_details: { order_id: `MEMOTO-${Date.now()}`, gross_amount: nominal }
      })
    });

    const midtransData = await midtransRes.json();

    // REM OTOMATIS: Jika Midtrans gagal buat QRIS, langsung lemparkan error
    if (midtransData.status_code !== "201" && midtransData.status_code !== "200") {
       throw new Error(midtransData.status_message || "Gagal membuat QRIS dari Midtrans");
    }

    return new Response(
      JSON.stringify({ sukses: true, data_midtrans: midtransData }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    return new Response(
      JSON.stringify({ sukses: false, pesan: error.message }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
