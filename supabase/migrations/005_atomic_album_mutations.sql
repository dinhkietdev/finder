-- Atomic per-album mutations for guest selections and CHECK notes.
-- The API uses service_role for these server-only functions. Each function
-- locks one album row, merges only the requested key, and releases the lock
-- before returning, so concurrent Vercel instances cannot lose updates.

create or replace function public.toggle_album_like(
  p_album_id text,
  p_file_key text,
  p_value jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_state jsonb;
  liked_images jsonb;
  existing_value jsonb;
  max_selections integer;
  selected_count integer;
  next_is_liked boolean;
  existing_is_liked boolean;
begin
  select coalesce(a.state, '{}'::jsonb), greatest(0, coalesce(nullif(a.settings->>'maxSelections', '')::integer, 0))
    into current_state, max_selections
    from public.albums a
   where a.id = p_album_id
   for update;

  if not found then
    return jsonb_build_object('success', false, 'code', 'ALBUM_NOT_FOUND', 'error', 'Không tìm thấy album.');
  end if;

  liked_images := coalesce(current_state->'likedImages', '{}'::jsonb);
  existing_value := liked_images->p_file_key;
  next_is_liked := coalesce((p_value->>'isLiked')::boolean, false);
  existing_is_liked := case jsonb_typeof(existing_value)
    when 'object' then coalesce((existing_value->>'isLiked')::boolean, false)
    when 'boolean' then existing_value::text::boolean
    else false
  end;

  if next_is_liked and not existing_is_liked and max_selections > 0 then
    select count(*)::integer
      into selected_count
      from jsonb_each(liked_images) as item(file_key, value)
     where case jsonb_typeof(item.value)
       when 'object' then coalesce((item.value->>'isLiked')::boolean, false)
       when 'boolean' then item.value::text::boolean
       else false
     end;
    if selected_count >= max_selections then
      return jsonb_build_object(
        'success', false,
        'code', 'SELECTION_LIMIT_REACHED',
        'error', format('Album này chỉ cho phép chọn tối đa %s ảnh.', max_selections)
      );
    end if;
  end if;

  current_state := jsonb_set(
    current_state,
    '{likedImages}',
    liked_images || jsonb_build_object(p_file_key, coalesce(p_value, '{}'::jsonb)),
    true
  );
  update public.albums
     set state = current_state,
         updated_at = now()
   where id = p_album_id;
  return jsonb_build_object('success', true);
end;
$$;

create or replace function public.merge_album_check_note(
  p_album_id text,
  p_file_key text,
  p_note text,
  p_settings_patch jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_state jsonb;
  current_settings jsonb;
  check_notes jsonb;
begin
  select coalesce(a.state, '{}'::jsonb), coalesce(a.settings, '{}'::jsonb)
    into current_state, current_settings
    from public.albums a
   where a.id = p_album_id
   for update;

  if not found then
    return jsonb_build_object('success', false, 'code', 'ALBUM_NOT_FOUND', 'error', 'Không tìm thấy album.');
  end if;

  check_notes := coalesce(current_state->'checkNotes', '{}'::jsonb);
  if nullif(trim(coalesce(p_note, '')), '') is null then
    check_notes := check_notes - p_file_key;
  else
    check_notes := check_notes || jsonb_build_object(p_file_key, trim(p_note));
  end if;
  current_settings := current_settings || coalesce(p_settings_patch, '{}'::jsonb);
  current_state := jsonb_set(
    jsonb_set(current_state, '{checkNotes}', check_notes, true),
    '{settings}',
    current_settings,
    true
  );
  update public.albums
     set settings = current_settings,
         state = current_state,
         workflow_status = coalesce(current_settings->>'workflowStatus', workflow_status),
         updated_at = now()
   where id = p_album_id;
  return jsonb_build_object('success', true);
end;
$$;

revoke all on function public.toggle_album_like(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.merge_album_check_note(text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.toggle_album_like(text, text, jsonb) to service_role;
grant execute on function public.merge_album_check_note(text, text, text, jsonb) to service_role;
