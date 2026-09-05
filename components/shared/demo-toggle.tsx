"use client";

import { usePathname, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';

export function DemoToggle() {
    const pathname = usePathname();
    const router = useRouter();

    const isManagerView = pathname === '/';
    const destinationView = isManagerView ? 'Candidate' : 'Manager';

    const toggleView = () => {
        if (isManagerView) {
            router.push('/apply?token=demo');
        } else {
            router.push('/');
        }
    };

    return (
        <div className="fixed bottom-6 right-6 z-50">
            <Button
                onClick={toggleView}
                aria-label={`Switch to ${destinationView.toLowerCase()} view`}
                className="min-h-11 bg-stone-800 hover:bg-stone-700 text-white px-5 py-3 rounded-full shadow-lg border border-stone-600 transition-all hover:scale-105 hover:shadow-xl"
            >
                <span className="mr-2">👁</span>
                <span className="font-medium">Switch to {destinationView}</span>
                <span className="ml-2 text-stone-400">↔</span>
            </Button>
        </div>
    );
}
