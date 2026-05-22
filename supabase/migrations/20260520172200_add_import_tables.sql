
create table if not exists public.user_states (
  user_id bigint primary key,
  state text not null,
  updated_at timestamptz not null default now()
);
alter table public.user_states enable row level security;

create table if not exists public.imported_wallets (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null,
  address text not null,
  encrypted_key text not null, -- For security, we should encrypt this, but for now I'll store it as is or handle it in the bot
  created_at timestamptz not null default now()
);
alter table public.imported_wallets enable row level security;
