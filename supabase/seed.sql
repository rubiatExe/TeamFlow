-- Local/demo-only Phase 4 policy catalog.
-- Apply after schema.sql when running the documented demo tenant. Production policy
-- configuration still requires an authenticated administrative workflow and review.

insert into public.merchants (id, email, store_name)
values (
  '00000000-0000-0000-0000-000000000001',
  'teamflow-demo@example.test',
  'TeamFlow Demo Cafe'
)
on conflict (id) do update
set store_name = excluded.store_name;

insert into public.jobs (
  id,
  merchant_id,
  title,
  is_active,
  scoring_policy_id,
  scoring_policy_version,
  scoring_criteria
)
values
  (
    '11111111-1111-4111-8111-111111111111',
    '00000000-0000-0000-0000-000000000001',
    'Barista',
    true,
    'barista-score-policy',
    '1.0.0',
    '[
      {
        "criterion_id": "cafe-experience",
        "criterion_text": "Cafe customer-service experience",
        "weight": 70
      },
      {
        "criterion_id": "espresso-equipment",
        "criterion_text": "Espresso equipment experience",
        "weight": 30
      }
    ]'::jsonb
  ),
  (
    '22222222-2222-4222-8222-222222222222',
    '00000000-0000-0000-0000-000000000001',
    'Retail Associate',
    true,
    'retail-score-policy',
    '1.0.0',
    '[
      {
        "criterion_id": "retail-experience",
        "criterion_text": "Retail customer-service experience",
        "weight": 60
      },
      {
        "criterion_id": "inventory-handling",
        "criterion_text": "Inventory handling experience",
        "weight": 40
      }
    ]'::jsonb
  )
on conflict (id) do update
set
  merchant_id = excluded.merchant_id,
  title = excluded.title,
  is_active = excluded.is_active,
  scoring_policy_id = excluded.scoring_policy_id,
  scoring_policy_version = excluded.scoring_policy_version,
  scoring_criteria = excluded.scoring_criteria;
