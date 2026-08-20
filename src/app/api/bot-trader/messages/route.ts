import { NextRequest, NextResponse } from 'next/server';
import { createBotMessage, getBotMessages, pruneBotMessages, updateBotMessage, type BotMessageStatus, type BotMessageType } from '@/lib/bot-trader-messages';
import { getConfigResolved, sendTelegramMessage } from '@/lib/telegram-alerts';
import { clientSafeError } from '@/lib/error-handler';
import { isAuthorizedBrowserMutation } from '@/lib/browser-session';

const statuses=new Set<BotMessageStatus>(['pending','sent','failed','paused']);
const types=new Set<BotMessageType>(['trade_placed','trade_failed','trade_aborted','alert','info']);

async function getResetBaseline(): Promise<{ resetAt: string } | null> {
  try {
    const { createClient } = await import('@libsql/client');
    const path = await import('path');
    const db = createClient({ url: `file:${path.join(process.cwd(), 'data', 'edgefinder.db')}` });
    try {
      const r = await db.execute('SELECT reset_at FROM bot_trader_reset_baseline ORDER BY id DESC LIMIT 1');
      const row = (r.rows as unknown as Array<Record<string, unknown>>)[0];
      return row ? { resetAt: String(row.reset_at) } : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export async function GET(req:NextRequest){try{const q=req.nextUrl.searchParams;const status=q.get('status')||undefined;const type=q.get('type')||undefined;if(status&&!statuses.has(status as BotMessageStatus))return NextResponse.json({error:'Invalid status'},{status:400});if(type&&!types.has(type as BotMessageType))return NextResponse.json({error:'Invalid type'},{status:400});const since=q.get('since')||undefined;if(since&&!Number.isFinite(Date.parse(since)))return NextResponse.json({error:'Invalid since date'},{status:400});const cursorRaw=q.get('cursor');const cursor=cursorRaw?Number(cursorRaw):undefined;if(cursorRaw&&(!Number.isInteger(cursor)||cursor!<=0))return NextResponse.json({error:'Invalid cursor'},{status:400});await pruneBotMessages(30);const baseline=await getResetBaseline();const effectiveSince=baseline&&(!since||since<baseline.resetAt)?baseline.resetAt:since;const result=await getBotMessages({status:status as BotMessageStatus|undefined,type:type as BotMessageType|undefined,marketId:q.get('marketId')||undefined,since:effectiveSince,cursor});const config=await getConfigResolved();return NextResponse.json({...result,success:true,config:{configured:Boolean(config),dedicated:Boolean(process.env.TELEGRAM_BOT_TRADER_CHAT_ID),chatId:config?(config.botTraderChatId||config.chatId):null}});}catch(error){return NextResponse.json({error:clientSafeError(error)},{status:500});}}
export async function POST(req:NextRequest){if(!await isAuthorizedBrowserMutation(req))return NextResponse.json({error:'Unauthorized'},{status:401});try{const body=await req.json();if(body?.action!=='test')return NextResponse.json({error:'Unknown action'},{status:400});const config=await getConfigResolved();const chatId=config?.botTraderChatId||config?.chatId;if(!config||!chatId)return NextResponse.json({error:'Telegram is not configured'},{status:400});const text='🤖 <b>EdgeFinder BotTrader test</b>\n\nDedicated BotTrader messaging is configured.';const id=await createBotMessage({chatId,messageText:text,messageType:'info',status:'pending'});const sent=await sendTelegramMessage(config.botToken,chatId,text);await updateBotMessage(id,sent.ok?{status:'sent',telegramMessageId:sent.messageId}:{status:'failed',errorReason:sent.error});return NextResponse.json({success:sent.ok,error:sent.error,messageId:id},{status:sent.ok?200:502});}catch(error){return NextResponse.json({error:clientSafeError(error)},{status:500});}}
