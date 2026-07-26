import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !serviceKey) {
  console.error('Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running this check.');
  process.exitCode = 1;
} else {
  const supabase = createClient(supabaseUrl, serviceKey);
  const merchantId = process.env.DEMO_MERCHANT_ID || '00000000-0000-0000-0000-000000000001';

  console.log(`Checking demo merchant: ${merchantId}`);

  const { data, error } = await supabase
    .from('merchants')
    .select('id')
    .eq('id', merchantId)
    .maybeSingle();

  if (error) {
    console.error('Supabase read failed:', error.message);
    process.exitCode = 1;
  } else if (data) {
    console.log('Supabase connection verified; demo merchant exists.');
  } else {
    console.log('Supabase connection verified; demo merchant is not seeded.');
  }
}
