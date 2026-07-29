-- Keep party/gallery creation and section additions atomic.  These writes are
-- server-only and must merge one album row at a time so concurrent Vercel
-- instances cannot restore an older gallerySections array.

create or replace function public.upsert_party_gallery(
  p_album_id text,
  p_public_slug text,
  p_drive_folder_id text,
  p_original_folder_id text,
  p_settings_patch jsonb,
  p_section jsonb,
  p_is_finalized boolean default true,
  p_workflow_status text default 'completed'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_settings jsonb;
  existing_state jsonb;
  existing_history jsonb;
  merged_settings jsonb;
  merged_state jsonb;
  merged_history jsonb;
  merged_sections jsonb := '[]'::jsonb;
  section_item jsonb;
  is_created boolean := false;
  current_gallery_type text;
begin
  select coalesce(a.settings, '{}'::jsonb),
         coalesce(a.state, '{}'::jsonb),
         coalesce(a.history, '{}'::jsonb),
         a.gallery_type
    into existing_settings, existing_state, existing_history, current_gallery_type
    from public.albums a
   where a.id = p_album_id
   for update;

  if not found then
    is_created := true;
    existing_settings := '{}'::jsonb;
    existing_state := '{}'::jsonb;
    existing_history := '{}'::jsonb;
  end if;

  -- Keep all existing settings, including a management token created by an
  -- earlier request.  The API only supplies the fields owned by this route.
  merged_settings := existing_settings || coalesce(p_settings_patch, '{}'::jsonb);

  if jsonb_typeof(existing_settings->'gallerySections') = 'array' then
    for section_item in select value from jsonb_array_elements(existing_settings->'gallerySections') loop
      if jsonb_typeof(p_section) <> 'object'
         or coalesce(section_item->>'driveFolderId', '') <> coalesce(p_section->>'driveFolderId', '') then
        merged_sections := merged_sections || jsonb_build_array(section_item);
      end if;
    end loop;
  end if;
  if jsonb_typeof(p_section) = 'object'
     and nullif(trim(coalesce(p_section->>'driveFolderId', '')), '') is not null then
    merged_sections := merged_sections || jsonb_build_array(p_section);
  end if;
  merged_settings := merged_settings || jsonb_build_object('gallerySections', merged_sections);
  merged_state := existing_state || jsonb_build_object('finalized', coalesce(p_is_finalized, true));
  merged_history := existing_history || jsonb_build_object('gallerySections', merged_sections);

  if is_created then
    insert into public.albums (
      id, public_slug, gallery_type, drive_folder_id, original_folder_id,
      settings, state, history, is_finalized, workflow_status, updated_at
    ) values (
      p_album_id,
      coalesce(nullif(trim(p_public_slug), ''), 'album-' || right(p_album_id, 6)),
      'party',
      p_drive_folder_id,
      p_original_folder_id,
      merged_settings,
      merged_state,
      merged_history,
      coalesce(p_is_finalized, true),
      coalesce(nullif(trim(p_workflow_status), ''), 'completed'),
      now()
    );
  else
    update public.albums
       set public_slug = coalesce(nullif(trim(p_public_slug), ''), public_slug),
           gallery_type = 'party',
           drive_folder_id = coalesce(nullif(trim(p_drive_folder_id), ''), drive_folder_id),
           original_folder_id = coalesce(nullif(trim(p_original_folder_id), ''), original_folder_id),
           settings = merged_settings,
           state = merged_state,
           history = merged_history,
           is_finalized = coalesce(p_is_finalized, is_finalized),
           workflow_status = coalesce(nullif(trim(p_workflow_status), ''), workflow_status),
           updated_at = now()
     where id = p_album_id;
  end if;

  return jsonb_build_object(
    'success', true,
    'created', is_created,
    'managementToken', merged_settings->>'managementToken',
    'publicSlug', coalesce(nullif(trim(p_public_slug), ''), 'album-' || right(p_album_id, 6)),
    'settings', merged_settings,
    'gallerySections', merged_sections
  );
exception
  when unique_violation then
    return jsonb_build_object('success', false, 'code', 'PUBLIC_SLUG_CONFLICT', 'error', 'Link gallery đã tồn tại.');
end;
$$;

create or replace function public.merge_party_gallery_section(
  p_album_id text,
  p_section jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_settings jsonb;
  current_history jsonb;
  merged_settings jsonb;
  merged_history jsonb;
  merged_sections jsonb := '[]'::jsonb;
  section_item jsonb;
begin
  select coalesce(a.settings, '{}'::jsonb), coalesce(a.history, '{}'::jsonb)
    into current_settings, current_history
    from public.albums a
   where a.id = p_album_id
     and (a.gallery_type = 'party' or a.settings->>'galleryType' = 'party')
   for update;

  if not found then
    return jsonb_build_object('success', false, 'code', 'PARTY_GALLERY_NOT_FOUND', 'error', 'Không tìm thấy gallery tiệc.');
  end if;
  if jsonb_typeof(p_section) <> 'object'
     or nullif(trim(coalesce(p_section->>'driveFolderId', '')), '') is null then
    return jsonb_build_object('success', false, 'code', 'INVALID_SECTION', 'error', 'Dữ liệu ngày/đợt ảnh không hợp lệ.');
  end if;

  if jsonb_typeof(current_settings->'gallerySections') = 'array' then
    for section_item in select value from jsonb_array_elements(current_settings->'gallerySections') loop
      if coalesce(section_item->>'driveFolderId', '') <> p_section->>'driveFolderId' then
        merged_sections := merged_sections || jsonb_build_array(section_item);
      end if;
    end loop;
  end if;
  merged_sections := merged_sections || jsonb_build_array(p_section);
  merged_settings := current_settings || jsonb_build_object('gallerySections', merged_sections);
  merged_history := current_history || jsonb_build_object('gallerySections', merged_sections);

  update public.albums
     set settings = merged_settings,
         history = merged_history,
         updated_at = now()
   where id = p_album_id;

  return jsonb_build_object('success', true, 'gallerySections', merged_sections, 'settings', merged_settings);
end;
$$;

revoke all on function public.upsert_party_gallery(text, text, text, text, jsonb, jsonb, boolean, text) from public, anon, authenticated;
revoke all on function public.merge_party_gallery_section(text, jsonb) from public, anon, authenticated;
grant execute on function public.upsert_party_gallery(text, text, text, text, jsonb, jsonb, boolean, text) to service_role;
grant execute on function public.merge_party_gallery_section(text, jsonb) to service_role;
