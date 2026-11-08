-- Run this once in the Supabase SQL Editor to enable shared notepad rooms.
-- Rooms are intentionally unlisted. A room with no password is accessible to
-- anyone who knows its name, so do not use rooms for sensitive information.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.note_rooms (
    room_name text primary key
        check (room_name ~ '^[a-z0-9][a-z0-9_-]{2,39}$'),
    password_hash text,
    content text not null default ''
        check (char_length(content) <= 100000),
    updated_at timestamptz not null default clock_timestamp()
);

alter table public.note_rooms enable row level security;
revoke all on public.note_rooms from anon, authenticated;

create or replace function public.create_note_room(
    p_room_name text,
    p_password text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_room_name text := lower(btrim(p_room_name));
    v_password_hash text;
    v_updated_at timestamptz;
begin
    if v_room_name is null
        or v_room_name !~ '^[a-z0-9][a-z0-9_-]{2,39}$' then
        raise exception 'Room names must be 3–40 characters and use letters, numbers, hyphens, or underscores.';
    end if;

    if p_password is not null and char_length(p_password) > 256 then
        raise exception 'Passwords can be at most 256 characters.';
    end if;

    if nullif(p_password, '') is not null then
        v_password_hash := extensions.crypt(
            pg_catalog.encode(extensions.digest(p_password, 'sha256'), 'hex'),
            extensions.gen_salt('bf', 12)
        );
    end if;

    insert into public.note_rooms (room_name, password_hash)
    values (v_room_name, v_password_hash)
    returning updated_at into v_updated_at;

    return pg_catalog.jsonb_build_object(
        'room_name', v_room_name,
        'content', '',
        'updated_at', v_updated_at
    );
exception
    when unique_violation then
        raise exception 'That room name is already in use.';
end;
$$;

create or replace function public.open_note_room(
    p_room_name text,
    p_password text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_room_name text := lower(btrim(p_room_name));
    v_password_hash text;
    v_content text;
    v_updated_at timestamptz;
begin
    if v_room_name is null
        or v_room_name !~ '^[a-z0-9][a-z0-9_-]{2,39}$'
        or (p_password is not null and char_length(p_password) > 256) then
        raise exception 'Room name or password is incorrect.';
    end if;

    select room.password_hash, room.content, room.updated_at
    into v_password_hash, v_content, v_updated_at
    from public.note_rooms as room
    where room.room_name = v_room_name;

    if not found then
        raise exception 'Room name or password is incorrect.';
    end if;

    if v_password_hash is not null and (
        p_password is null
        or extensions.crypt(
            pg_catalog.encode(extensions.digest(p_password, 'sha256'), 'hex'),
            v_password_hash
        ) <> v_password_hash
    ) then
        raise exception 'Room name or password is incorrect.';
    end if;

    return pg_catalog.jsonb_build_object(
        'room_name', v_room_name,
        'content', v_content,
        'updated_at', v_updated_at
    );
end;
$$;

create or replace function public.save_note_room(
    p_room_name text,
    p_password text,
    p_content text,
    p_expected_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_room_name text := lower(btrim(p_room_name));
    v_password_hash text;
    v_updated_at timestamptz;
begin
    if v_room_name is null
        or v_room_name !~ '^[a-z0-9][a-z0-9_-]{2,39}$'
        or (p_password is not null and char_length(p_password) > 256)
        or p_content is null
        or char_length(p_content) > 100000
        or p_expected_updated_at is null then
        raise exception 'Invalid room update.';
    end if;

    select room.password_hash, room.updated_at
    into v_password_hash, v_updated_at
    from public.note_rooms as room
    where room.room_name = v_room_name
    for update;

    if not found or (
        v_password_hash is not null and (
            p_password is null
            or extensions.crypt(
                pg_catalog.encode(extensions.digest(p_password, 'sha256'), 'hex'),
                v_password_hash
            ) <> v_password_hash
        )
    ) then
        raise exception 'Room name or password is incorrect.';
    end if;

    if v_updated_at is distinct from p_expected_updated_at then
        raise exception 'This room changed since your last sync. Load the latest version before saving.';
    end if;

    update public.note_rooms
    set content = p_content,
        updated_at = clock_timestamp()
    where room_name = v_room_name
    returning updated_at into v_updated_at;

    return pg_catalog.jsonb_build_object('updated_at', v_updated_at);
end;
$$;

revoke all on function public.create_note_room(text, text) from public;
revoke all on function public.open_note_room(text, text) from public;
revoke all on function public.save_note_room(text, text, text, timestamptz) from public;
grant execute on function public.create_note_room(text, text) to anon, authenticated;
grant execute on function public.open_note_room(text, text) to anon, authenticated;
grant execute on function public.save_note_room(text, text, text, timestamptz) to anon, authenticated;
