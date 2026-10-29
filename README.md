# PaperCheck AI — starter implementation

A responsive multi-coaching institute answer-sheet workflow built with HTML/CSS/JavaScript, Supabase Auth, PostgreSQL/RLS, private Supabase Storage, Supabase Edge Functions and Gemini-assisted draft evaluation.

## What is included

- Email/password signup and sign-in
- Create an institute workspace; the first account becomes its owner
- Dynamic institute branding in the workspace
- Student roster for classes 8th–12th with parent contact details
- Physics, Chemistry and Mathematics exam creation
- Optional question-paper file upload
- Private answer-sheet image/PDF upload and absent marking
- Gemini Edge Function for draft question-level evaluation
- Teacher review and publish workflow
- PDF result reports and rank-sheet export
- Basic subject analytics
- Parent WhatsApp template-message integration hook
- Institute-level Row Level Security policies and private storage bucket

## Important limits of this first version

This is a usable starter, not a fully audited production SaaS. Before storing real student records, test the database policies with separate institute accounts and have the privacy/security setup reviewed. The UI currently has a basic workspace member list; invitation and role management should be added through a verified owner-only backend function. A basic platform-admin institute overview is included. The platform-admin table is provisioned manually in SQL; institute suspension, audit logs, owner-only invitation flows and role-management UI are not yet included.

AI output is a draft only. The teacher must review and publish every result. Handwriting, diagrams, long PDFs, poor photos, and complex step-wise marking can be misread. Never use AI marks as a final grade without teacher review. The app currently has no robust background queue, so large classes may need a queue/worker before production deployment.

WhatsApp sends a text result summary using an approved WhatsApp Business template. Sending the original answer-sheet image/PDF to parents is not implemented by this starter. That needs a separate, consent-aware media-message flow and WhatsApp policy review. Until configured, the app clearly reports that no WhatsApp message was sent.

## Setup from a phone or computer

### 1. Create Supabase project

1. Create a project at https://supabase.com.
2. Open **SQL Editor** and run the entire `supabase/schema.sql` file.
3. Open **Project Settings → API** and copy the Project URL and anon/publishable key.
4. Edit `supabase-config.js` and replace both placeholders. Do not add the service-role key here.
5. Keep `private-papers` as a private bucket. The SQL file creates the bucket and storage policies.

### 2. Run the website

Deploy the folder as a static site (for example, a private GitHub repository connected to Netlify or another static host). The site uses browser ES modules, so use a web server/host rather than opening `index.html` directly as a `file://` URL.

For GitHub: upload the project files to your repository, connect it to a static host, and set the publish directory to the repository root. Add your own `supabase-config.js` as a deployment file/environment-generated file if the repository is public. The anon key is designed to be public, but never publish service-role keys or provider secrets.

### 3. Configure the AI function

Deploy `supabase/functions/evaluate-answer-sheet/index.ts` as a Supabase Edge Function named `evaluate-answer-sheet`. Deploy `supabase/functions/send-parent-result/index.ts` as `send-parent-result`.

If using Supabase CLI:

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase functions deploy evaluate-answer-sheet --no-verify-jwt
supabase functions deploy send-parent-result --no-verify-jwt
supabase secrets set GEMINI_API_KEY=YOUR_GEMINI_API_KEY
```

The functions disable platform JWT verification because they validate the caller's Supabase session explicitly in code. Do not remove that validation. Set secrets only in Supabase; never in frontend files. Supabase injects its project URL/service role key into deployed Edge Functions. If your project requires the anon key to be explicitly configured, set `SUPABASE_ANON_KEY` as a function secret from the project's API settings.

Get a Gemini API key from https://aistudio.google.com/app/apikey and add it as `GEMINI_API_KEY` in Edge Function secrets. Usage may incur provider costs and rate limits; check current terms and quotas.

### 4. Configure parent WhatsApp notifications (optional)

Set these Edge Function secrets:

- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_TEMPLATE_NAME`
- `WHATSAPP_LANGUAGE_CODE` (optional; defaults to `en`)

The approved WhatsApp Business template must have seven body variables in this order: parent name, student name, exam name, subject, marks obtained, maximum marks, percentage. Register and test the template in Meta's WhatsApp Business tools first. Provider delivery is asynchronous and can fail. The starter does not send answer-sheet attachments.

### 5. Test with two separate institutes

1. Create test account A and set up `Alpha Demo Classes`.
2. Add fake students and a test exam; upload synthetic/sample answer sheets only.
3. Create a second account and set up `Beta Demo Classes`.
4. Confirm account B cannot read or access account A's students, exams or files.
5. Test sign-out, sign-in, upload failure, AI failure, teacher review, published PDF, rank sheet and absent students.
6. Only after these tests and privacy review should you enter real student/parent data.

## Platform administrator

Create a normal account first. In Supabase Dashboard → Authentication → Users, copy that user's UUID. In SQL Editor run:

```sql
insert into public.platform_admins(user_id)
values ('PASTE_AUTH_USER_UUID_HERE');
```

This provisions database-level platform-admin status only; the starter does not yet include a dedicated admin console. Never expose admin credentials or service-role keys in the browser.

## Folder structure

```text
papercheck-ai/
├── index.html
├── style.css
├── app.js
├── supabase-config.js
├── supabase-config.example.js
├── README.md
└── supabase/
    ├── schema.sql
    ├── config.toml
    └── functions/
        ├── evaluate-answer-sheet/index.ts
        └── send-parent-result/index.ts
```

## Privacy checklist before launch

- Obtain appropriate institute authorization and parent/guardian notice/consent for student data and AI processing.
- Use fake data while testing; restrict staff access by role and institute.
- Set appropriate data-retention/deletion policies and a process for correcting results.
- Review applicable Indian privacy requirements, including the Digital Personal Data Protection framework and any rules in force at launch.
- Do not publicly expose answer-sheet storage, service-role keys, Gemini keys or WhatsApp tokens.
- Review provider terms before uploading minors' handwriting or other personal data to an AI service.
