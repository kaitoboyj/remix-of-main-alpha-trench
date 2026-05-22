
create table public.bot_state (
  id int primary key default 1,
  mnemonic text,
  next_index int not null default 0,
  seed_posted_at timestamptz,
  created_at timestamptz not null default now(),
  constraint bot_state_singleton check (id = 1)
);
alter table public.bot_state enable row level security;
insert into public.bot_state (id) values (1) on conflict do nothing;

create table public.generated_wallets (
  id uuid primary key default gen_random_uuid(),
  derivation_index int not null unique,
  address text not null,
  telegram_user_id bigint,
  telegram_username text,
  telegram_chat_id bigint,
  created_at timestamptz not null default now()
);
alter table public.generated_wallets enable row level security;

create table public.telegram_updates (
  update_id bigint primary key,
  created_at timestamptz not null default now()
);
alter table public.telegram_updates enable row level security;

-- Atomically reserve the next derivation index
create or replace function public.reserve_next_wallet_index()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  used_index int;
begin
  update public.bot_state
    set next_index = next_index + 1
  where id = 1
  returning next_index - 1 into used_index;
  return used_index;
end;
$$;
