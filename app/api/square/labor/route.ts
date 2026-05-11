import { NextResponse } from 'next/server';
import { CAFE_ROLES } from '@/lib/roles';

// Square Labor API simulation — now sourced from centralized role config
// In production, this would call Square's Team & Labor APIs

const DEMO_STORE = {
    merchantId: 'MLXYZ123456789',
    name: "Cocoa Bakery",
    logo: "☕",
    primaryColor: "#84cc16",
    address: {
        line1: "123 Main St",
        city: "Brooklyn",
        state: "NY",
        postalCode: "11201"
    }
};

export async function GET() {
    // Simulate API latency
    await new Promise(resolve => setTimeout(resolve, 200));

    // Generate jobs from the centralized role config
    const jobs = CAFE_ROLES.map(role => ({
        id: `job_${role.id}`,
        title: role.title,
        wageMin: role.wageRange.min,
        wageMax: role.wageRange.max,
        isActive: true,
        roleId: role.id,
        description: role.description,
        dealbreakers: role.dealbreakers,
    }));

    return NextResponse.json({
        store: DEMO_STORE,
        jobs,
        syncedAt: new Date().toISOString()
    });
}
