require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
);

async function fix() {
  const merchantId = process.env.DEMO_MERCHANT_ID || '00000000-0000-0000-0000-000000000001';
  console.log(`Checking merchant: ${merchantId}`);
  
  const { data, error } = await supabase
    .from('merchants')
    .select('id')
    .eq('id', merchantId)
    .single();
    
  if (error || !data) {
    console.log("Merchant not found, inserting...");
    const { error: insertError } = await supabase
      .from('merchants')
      .insert({ id: merchantId, name: "Demo Cafe" });
      
    if (insertError) {
      console.error("Failed to insert:", insertError);
    } else {
      console.log("Successfully inserted demo merchant!");
    }
  } else {
    console.log("Merchant already exists.");
  }
}
fix();
