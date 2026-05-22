# Wallet balance detection + CA-after-/start handling

## Goals

1. Real Solana wallet balance reads (SOL + SPL tokens) on `https://api.mainnet-beta.solana.com` via `@solana/web3.js`.
2. Show that balance whenever a wallet is **generated**, **imported**, or **pasted** (e.g. Copy Trade target address).
3. If a user's **own** wallet (generated or imported) has **less than 15 SOL**, the bot tells them to top up — without naming a target amount.
4. After `/start`, if the user pastes a **token contract address** (instead of pressing a button), show the token details card and re-render the **main menu buttons** underneath it.

## Behavior

### Balance detection (everywhere)
For a given address show:
```
SOL: <amount> SOL
Tokens:
  • <symbol> — <uiAmount>
  • <symbol> — <uiAmount>
  ...
```
- Query SOL via `connection.getBalance`.
- Query SPL tokens via `getParsedTokenAccountsByOwner` for **both** programs:
  - SPL Token (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`)
  - Token-2022 (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`)
- Filter out accounts with `uiAmount === 0`.
- Resolve a human symbol per mint via DexScreener (`/latest/dex/tokens/<mint>`, take strongest Solana pair's `baseToken.symbol`), with a small in-request cache and a fallback to short-mint (`Mint(abcd…wxyz)`). Cap at 20 tokens to keep the message tidy; show "+N more" if truncated.
- Wrap in `try/catch`; on RPC failure show `(balance unavailable — try again)` instead of crashing.

### When to surface balance + low-balance warning
- **`/generate`**: after the wallet is created, fetch and show the balance card. Always append the low-balance warning since a new wallet is 0 SOL.
- **Import (private key or seed)**: replace the current "X tokens" line with the full breakdown. Add low-balance warning when SOL < 15.
- **Copy Trade target address** (state `AWAIT_CT_ADDR`): show full breakdown for the target wallet. **Do not** show the low-balance warning here (it's not the user's wallet).

Warning text (verbatim, no amount mentioned):
```
⚠️ Your wallet balance is too low. Please top up your wallet to continue.
```

### CA pasted after `/start` (no button pressed)
- In the "no state" fallback branch, detect if the text is a valid Solana address via `isLikelySolanaAddress`.
- Run `fetchTokenInfo(text)`:
  - If it returns a token → send the same token card used by the Buy flow, with `mainMenuKeyboard()` as `reply_markup`.
  - If it returns `null` (valid address but no token data) → treat it as a wallet address and show its SOL + SPL breakdown, with `mainMenuKeyboard()` underneath.
- Leaves all existing commands and stateful flows untouched.

## Technical changes (single file: `src/routes/api/public/telegram/webhook.ts`)

1. Replace `getWalletBalances` with a richer version that returns:
   ```ts
   { solBalance: number; tokens: Array<{ symbol: string; amount: number; mint: string }>; truncated: boolean }
   ```
   and a `formatBalanceCard(address, result)` helper that renders the multi-line block.
2. Add `TOKEN_2022_PROGRAM_ID` and query both programs in parallel.
3. Add `LOW_SOL_THRESHOLD = 15` and a `lowBalanceNotice(sol)` helper returning the warning string (or empty).
4. Update the three call sites:
   - `handleGenerate` — append balance card + low-balance notice to the user message.
   - `AWAITING_PK` / `AWAITING_SEED` branch — use new card; append low-balance notice.
   - `AWAIT_CT_ADDR` branch — use new card; no notice.
5. In the `else` "stateful text handlers" block, add a final fallback: if no state matched and the text is a valid Solana address, run the CA-or-wallet detection described above and reply with `mainMenuKeyboard()`.

No DB migration, no new dependencies, no other route changes.

## Notes / caveats

- Public mainnet RPC rate-limits aggressively. Balance calls are best-effort; on 429 / timeout the bot falls back to "(balance unavailable — try again)" and the flow still completes.
- The 15-SOL threshold applies only to the user's **own** wallets (generated/imported), not to pasted lookup addresses.
- Symbol resolution uses DexScreener only (already in the project). Unknown mints render as `Mint(abcd…wxyz)` so the user still sees the holding.
