import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const GONE = { error: 'Per-agent knowledge API removed. Use /api/wiki-folders instead.', docs: '/api/wiki-folders' };

export async function GET()    { return NextResponse.json(GONE, { status: 410 }); }
export async function POST()   { return NextResponse.json(GONE, { status: 410 }); }
export async function PATCH()  { return NextResponse.json(GONE, { status: 410 }); }
export async function PUT()    { return NextResponse.json(GONE, { status: 410 }); }
export async function DELETE() { return NextResponse.json(GONE, { status: 410 }); }
