import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Konfigurasi Header CORS agar aplikasi Photobooth tidak diblokir
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': '*', // Izinkan semua header agar tidak rewel
};

serve(async (req) => {
  // Langsung balas OPTIONS tanpa mikir panjang
  if (req.method === 'OPTIONS') {
    return new Response(null, { 
      status: 204, // Status 'No Content' standar untuk OPTIONS
      headers: corsHeaders 
    });
  }

  try {
    // 1. Ambil data harga dari aplikasi Photobooth
    const { nominal } = await req.json();

    if (!nominal) {
      throw new Error("Nominal pembayaran tidak boleh kosong.");
    }

    // 2. Hubungkan ke Database Supabase VPS Anda
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const supabase = createClient(supabaseUrl, supabaseKey);

    // 3. Ambil Server Key Midtrans dari tabel 'payment_keys'
    const { data: keyData, error: dbError } = await supabase
      .from('payment_keys')
      .select('api_key')
      .eq('type', 'Midtrans')
      .single(); // Ambil 1 baris saja

    if (dbError || !keyData) {
      throw new Error("Gagal mengambil kunci Midtrans dari database.");
    }

    const serverKey = keyData.api_key; // Ini berisi "SB-Mid-server-..."

    // 4. Siapkan request ke API Midtrans (Core API Sandbox)
    // Midtrans mewajibkan Server Key diubah ke format Base64 ditambah titik dua ":"
    const authString = btoa(`${serverKey}:`);
    const orderId = `MEMOTO-SESSION-${Date.now()}`; // Buat ID Order unik

    const midtransRes = await fetch("https://api.sandbox.midtrans.com/v2/charge", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": `Basic ${authString}`
      },
      body: JSON.stringify({
        payment_type: "qris",
        transaction_details: {
          order_id: orderId,
          gross_amount: nominal
        }
      })
    });

    const midtransData = await midtransRes.json();

    // Cek jika Midtrans menolak request
    if (midtransData.status_code !== "201") {
       throw new Error(`Midtrans Error: ${midtransData.status_message}`);
    }

    // 5. Kembalikan data QRIS ke Aplikasi Photobooth
    return new Response(
      JSON.stringify({ 
        sukses: true, 
        pesan: "QRIS berhasil dibuat",
        order_id: orderId,
        data_midtrans: midtransData 
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    return new Response(
      JSON.stringify({ sukses: false, pesan: error.message }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 }
    );
  }
});
