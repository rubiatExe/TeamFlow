import { NextResponse } from 'next/server';
import { loadCandidatesFromSupabase, deleteCandidateFromSupabase } from '@/lib/db/supabase';
import { guardLegacyDemoRoute } from '@/lib/http/legacy-demo-route';

// This API route proxies Supabase requests from the client securely.
// Because it runs on the server, `getSupabase()` in `lib/db/supabase.ts` will use
// the `SUPABASE_SERVICE_ROLE_KEY` and bypass any Row Level Security (RLS) restrictions!

export async function GET(req: Request) {
    const blocked = guardLegacyDemoRoute();
    if (blocked) return blocked;

    const { searchParams } = new URL(req.url);
    const merchantId = searchParams.get('merchant_id') || '00000000-0000-0000-0000-000000000001';
    
    // Call the server-side Supabase function directly
    const candidates = await loadCandidatesFromSupabase(merchantId);
    return NextResponse.json(candidates);
}

export async function DELETE(req: Request) {
    const blocked = guardLegacyDemoRoute();
    if (blocked) return blocked;

    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');
    
    if (!id) {
        return NextResponse.json({ error: 'Missing candidate ID' }, { status: 400 });
    }

    const success = await deleteCandidateFromSupabase(id);
    if (!success) {
        return NextResponse.json({ error: 'Failed to delete candidate' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
}
