
create table if not exists public.user_states (
  user_id bigint primary key,
  state text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.imported_wallets (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint,
  address text not null,
  encrypted_key text not null,
  created_at timestamptz not null default now()
);

alter table public.user_states enable row level security;
alter table public.imported_wallets enable row level security;
