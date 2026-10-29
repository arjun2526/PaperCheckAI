-- PaperCheck AI database schema. Run in Supabase SQL Editor as project owner.
create extension if not exists pgcrypto;

create table if not exists public.institutes (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 100),
  official_phone text,
  location text,
  website text,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.institute_memberships (
  institute_id uuid not null references public.institutes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'teacher' check (role in ('owner','teacher')),
  created_at timestamptz not null default now(),
  primary key (institute_id,user_id)
);
create index if not exists institute_memberships_user_idx on public.institute_memberships(user_id);
create table if not exists public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create table if not exists public.students (
  id uuid primary key default gen_random_uuid(),
  institute_id uuid not null references public.institutes(id) on delete cascade,
  full_name text not null check (char_length(full_name) between 1 and 100),
  class_name text not null check (class_name in ('8th','9th','10th','11th','12th')),
  roll_number text,
  parent_name text,
  parent_phone text not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists students_institute_class_idx on public.students(institute_id,class_name);
create table if not exists public.exams (
  id uuid primary key default gen_random_uuid(),
  institute_id uuid not null references public.institutes(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  class_name text not null check (class_name in ('8th','9th','10th','11th','12th')),
  subject text not null check (subject in ('Physics','Chemistry','Mathematics')),
  max_marks numeric(8,2) not null check (max_marks > 0),
  exam_date date not null,
  teacher_name text,
  marking_scheme text,
  question_file_path text,
  status text not null default 'collecting' check (status in ('collecting','checking','needs_review','published','archived')),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists exams_institute_date_idx on public.exams(institute_id,exam_date desc);
create table if not exists public.answer_sheets (
  id uuid primary key default gen_random_uuid(),
  institute_id uuid not null references public.institutes(id) on delete cascade,
  exam_id uuid not null references public.exams(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  file_paths text[] not null default '{}',
  teacher_notes text,
  status text not null default 'uploaded' check (status in ('uploaded','processing','needs_review','evaluated','published','absent','failed')),
  absent boolean not null default false,
  processing_started_at timestamptz,
  processing_finished_at timestamptz,
  error_message text,
  uploaded_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(exam_id,student_id)
);
create index if not exists answer_sheets_institute_status_idx on public.answer_sheets(institute_id,status);
create table if not exists public.results (
  id uuid primary key default gen_random_uuid(),
  institute_id uuid not null references public.institutes(id) on delete cascade,
  answer_sheet_id uuid not null unique references public.answer_sheets(id) on delete cascade,
  exam_id uuid not null references public.exams(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  marks_obtained numeric(8,2) not null default 0 check (marks_obtained >= 0),
  max_marks numeric(8,2) not null check (max_marks > 0),
  question_feedback jsonb not null default '[]'::jsonb,
  overall_feedback text,
  confidence numeric(4,3),
  status text not null default 'needs_review' check (status in ('needs_review','published','rejected')),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (marks_obtained <= max_marks)
);
create index if not exists results_institute_status_idx on public.results(institute_id,status);
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  institute_id uuid not null references public.institutes(id) on delete cascade,
  result_id uuid references public.results(id) on delete set null,
  student_id uuid references public.students(id) on delete set null,
  channel text not null default 'whatsapp' check (channel in ('whatsapp','email','manual')),
  recipient text,
  status text not null default 'queued' check (status in ('queued','sent','delivered','failed','not_configured')),
  provider_message_id text,
  error_message text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create or replace function public.is_institute_member(target_institute uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.institute_memberships m where m.institute_id=target_institute and m.user_id=auth.uid());
$$;
create or replace function public.is_institute_owner(target_institute uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.institute_memberships m where m.institute_id=target_institute and m.user_id=auth.uid() and m.role='owner');
$$;
create or replace function public.is_platform_admin()
returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.platform_admins a where a.user_id=auth.uid());
$$;
revoke all on function public.is_institute_member(uuid) from public;
grant execute on function public.is_institute_member(uuid) to authenticated;
revoke all on function public.is_institute_owner(uuid) from public;
grant execute on function public.is_institute_owner(uuid) to authenticated;
revoke all on function public.is_platform_admin() from public;
grant execute on function public.is_platform_admin() to authenticated;

-- Atomically create the institute and its first owner membership.
create or replace function public.create_institute_workspace(p_name text,p_phone text default null,p_location text default null,p_website text default null)
returns uuid language plpgsql security definer set search_path=public as $$
declare new_id uuid;
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  if char_length(trim(coalesce(p_name,''))) < 2 then raise exception 'Institute name must be at least 2 characters.'; end if;
  if exists(select 1 from public.institute_memberships where user_id=auth.uid()) then raise exception 'This account already belongs to an institute. Ask an institute owner to manage additional workspaces.'; end if;
  insert into public.institutes(name,official_phone,location,website,created_by)
  values(trim(p_name),nullif(trim(coalesce(p_phone,'')),''),nullif(trim(coalesce(p_location,'')),''),nullif(trim(coalesce(p_website,'')),''),auth.uid()) returning id into new_id;
  insert into public.institute_memberships(institute_id,user_id,role) values(new_id,auth.uid(),'owner');
  return new_id;
end; $$;
revoke all on function public.create_institute_workspace(text,text,text,text) from public;
grant execute on function public.create_institute_workspace(text,text,text,text) to authenticated;

-- Do not let normal users grant themselves roles or edit memberships directly.
revoke insert,update,delete on public.institute_memberships from anon,authenticated;
grant select on public.institute_memberships to authenticated;
revoke insert,update,delete on public.platform_admins from anon,authenticated;
revoke all on public.platform_admins from anon,authenticated;

alter table public.institutes enable row level security;
alter table public.institute_memberships enable row level security;
alter table public.platform_admins enable row level security;
alter table public.students enable row level security;
alter table public.exams enable row level security;
alter table public.answer_sheets enable row level security;
alter table public.results enable row level security;
alter table public.notifications enable row level security;

drop policy if exists "members read their institute" on public.institutes;
create policy "members read their institute" on public.institutes for select to authenticated using (public.is_institute_member(id) or public.is_platform_admin());
drop policy if exists "owners update institute" on public.institutes;
create policy "owners update institute" on public.institutes for update to authenticated using (public.is_institute_owner(id) or public.is_platform_admin()) with check (public.is_institute_owner(id) or public.is_platform_admin());
drop policy if exists "members read membership" on public.institute_memberships;
create policy "members read membership" on public.institute_memberships for select to authenticated using (user_id=auth.uid() or public.is_institute_member(institute_id) or public.is_platform_admin());
drop policy if exists "admins read platform admins" on public.platform_admins;
create policy "admins read platform admins" on public.platform_admins for select to authenticated using (user_id=auth.uid() or public.is_platform_admin());

-- Students: members can read; owner/teacher members can manage student records within their institute.
create policy "members read students" on public.students for select to authenticated using (public.is_institute_member(institute_id) or public.is_platform_admin());
create policy "members add students" on public.students for insert to authenticated with check ((public.is_institute_member(institute_id) and created_by=auth.uid()) or public.is_platform_admin());
create policy "members update students" on public.students for update to authenticated using (public.is_institute_member(institute_id) or public.is_platform_admin()) with check (public.is_institute_member(institute_id) or public.is_platform_admin());
create policy "owners delete students" on public.students for delete to authenticated using (public.is_institute_owner(institute_id) or public.is_platform_admin());
create policy "members read exams" on public.exams for select to authenticated using (public.is_institute_member(institute_id) or public.is_platform_admin());
create policy "members create exams" on public.exams for insert to authenticated with check ((public.is_institute_member(institute_id) and created_by=auth.uid()) or public.is_platform_admin());
create policy "members update exams" on public.exams for update to authenticated using (public.is_institute_member(institute_id) or public.is_platform_admin()) with check (public.is_institute_member(institute_id) or public.is_platform_admin());
create policy "owners delete exams" on public.exams for delete to authenticated using (public.is_institute_owner(institute_id) or public.is_platform_admin());
create policy "members read answer sheets" on public.answer_sheets for select to authenticated using (public.is_institute_member(institute_id) or public.is_platform_admin());
create policy "members create answer sheets" on public.answer_sheets for insert to authenticated with check ((public.is_institute_member(institute_id) and (uploaded_by is null or uploaded_by=auth.uid())) or public.is_platform_admin());
create policy "members update answer sheets" on public.answer_sheets for update to authenticated using (public.is_institute_member(institute_id) or public.is_platform_admin()) with check (public.is_institute_member(institute_id) or public.is_platform_admin());
create policy "owners delete answer sheets" on public.answer_sheets for delete to authenticated using (public.is_institute_owner(institute_id) or public.is_platform_admin());
create policy "members read results" on public.results for select to authenticated using (public.is_institute_member(institute_id) or public.is_platform_admin());
create policy "members create results" on public.results for insert to authenticated with check (public.is_institute_member(institute_id) or public.is_platform_admin());
create policy "members update results" on public.results for update to authenticated using (public.is_institute_member(institute_id) or public.is_platform_admin()) with check (public.is_institute_member(institute_id) or public.is_platform_admin());
create policy "members read notifications" on public.notifications for select to authenticated using (public.is_institute_member(institute_id) or public.is_platform_admin());
create policy "members create notifications" on public.notifications for insert to authenticated with check ((public.is_institute_member(institute_id) and (created_by is null or created_by=auth.uid())) or public.is_platform_admin());
create policy "members update notifications" on public.notifications for update to authenticated using (public.is_institute_member(institute_id) or public.is_platform_admin()) with check (public.is_institute_member(institute_id) or public.is_platform_admin());

-- Private bucket. Keep all files private and access them through signed URLs.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('private-papers','private-papers',false,15728640,array['image/jpeg','image/png','image/webp','image/heic','application/pdf'])
on conflict(id) do update set public=false,file_size_limit=15728640,allowed_mime_types=array['image/jpeg','image/png','image/webp','image/heic','application/pdf'];
drop policy if exists "institute members upload private papers" on storage.objects;
create policy "institute members upload private papers" on storage.objects for insert to authenticated with check (bucket_id='private-papers' and public.is_institute_member(((storage.foldername(name))[1])::uuid));
drop policy if exists "institute members read private papers" on storage.objects;
create policy "institute members read private papers" on storage.objects for select to authenticated using (bucket_id='private-papers' and public.is_institute_member(((storage.foldername(name))[1])::uuid));
drop policy if exists "institute members update private papers" on storage.objects;
create policy "institute members update private papers" on storage.objects for update to authenticated using (bucket_id='private-papers' and public.is_institute_member(((storage.foldername(name))[1])::uuid)) with check (bucket_id='private-papers' and public.is_institute_member(((storage.foldername(name))[1])::uuid));
drop policy if exists "institute owners delete private papers" on storage.objects;
create policy "institute owners delete private papers" on storage.objects for delete to authenticated using (bucket_id='private-papers' and public.is_institute_owner(((storage.foldername(name))[1])::uuid));

-- Important: add a trusted platform admin manually in SQL after the user's auth account exists:
-- insert into public.platform_admins(user_id) values ('YOUR-AUTH-USER-UUID');

-- Explicit API grants for projects where default privileges are restricted.
grant usage on schema public to authenticated;
grant select,update on public.institutes to authenticated;
grant select on public.institute_memberships to authenticated;
grant select on public.platform_admins to authenticated;
grant select,insert,update,delete on public.students to authenticated;
grant select,insert,update,delete on public.exams to authenticated;
grant select,insert,update,delete on public.answer_sheets to authenticated;
grant select,insert,update,delete on public.results to authenticated;
grant select,insert,update,delete on public.notifications to authenticated;
