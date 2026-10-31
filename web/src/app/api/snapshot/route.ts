import { NextResponse } from 'next/server';
import { getSnapshot } from '@/lib/runtime';

// Prevents Next.js from aggressively caching this route at build time.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
    try {
        const snapshot = await getSnapshot();
        return NextResponse.json(snapshot);
    } catch (error) {
        console.error("Failed to build snapshot:", error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : String(error) },
            { status: 500 }
        );
    }
}
