import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
const safeText = (v: unknown, max = 12000) => String(v ?? '').slice(0, max);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const geminiKey = Deno.env.get('GEMINI_API_KEY');
  if (!supabaseUrl || !anonKey || !serviceKey) return json({ error: 'Server configuration is incomplete.' }, 500);
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Sign in required.' }, 401);
  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: authData, error: authError } = await userClient.auth.getUser();
  if (authError || !authData.user) return json({ error: 'Invalid session.' }, 401);
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  let answerSheetId: string;
  try { answerSheetId = String((await req.json()).answer_sheet_id || ''); } catch { return json({ error: 'Invalid JSON body.' }, 400); }
  if (!answerSheetId) return json({ error: 'answer_sheet_id is required.' }, 400);
  const { data: sheet, error: sheetError } = await admin.from('answer_sheets').select('*').eq('id', answerSheetId).single();
  if (sheetError || !sheet) return json({ error: 'Answer sheet not found.' }, 404);
  const { data: membership } = await admin.from('institute_memberships').select('role').eq('institute_id', sheet.institute_id).eq('user_id', authData.user.id).maybeSingle();
  const { data: platformAdmin } = await admin.from('platform_admins').select('user_id').eq('user_id', authData.user.id).maybeSingle();
  if (!membership && !platformAdmin) return json({ error: 'You do not have access to this institute.' }, 403);
  if (sheet.status === 'absent') return json({ error: 'Absent students cannot be evaluated.' }, 409);
  if (!Array.isArray(sheet.file_paths) || sheet.file_paths.length === 0) return json({ error: 'No answer sheet files have been uploaded.' }, 400);
  if (!geminiKey) return json({ error: 'AI is not configured yet. Add GEMINI_API_KEY to Supabase Edge Function secrets.' }, 503);

  const { data: exam, error: examError } = await admin.from('exams').select('*').eq('id', sheet.exam_id).single();
  const { data: student, error: studentError } = await admin.from('students').select('*').eq('id', sheet.student_id).single();
  if (examError || !exam || studentError || !student) return json({ error: 'Exam or student record not found.' }, 404);
  if (exam.institute_id !== sheet.institute_id || student.institute_id !== sheet.institute_id) return json({ error: 'Institute data mismatch.' }, 403);

  await admin.from('answer_sheets').update({ status: 'processing', processing_started_at: new Date().toISOString(), error_message: null }).eq('id', sheet.id);
  try {
    const parts: Array<Record<string, unknown>> = [];
    const addStorageFile = async (path: string, label: string) => {
      // A path must belong to this institute's private folder.
      if (!path.startsWith(`${sheet.institute_id}/`)) throw new Error('File path is outside this institute workspace.');
      const { data: file, error } = await admin.storage.from('private-papers').download(path);
      if (error || !file) throw new Error(`Could not read ${label} from private storage.`);
      if (file.size > 15 * 1024 * 1024) throw new Error(`${label} exceeds the 15 MB limit.`);
      const mimeType = file.type || (path.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg');
      if (!mimeType.startsWith('image/') && mimeType !== 'application/pdf') throw new Error(`${label} is not a supported image or PDF.`);
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      parts.push({ text: `${label}:` }, { inline_data: { mime_type: mimeType, data: btoa(binary) } });
    };
    if (exam.question_file_path) await addStorageFile(exam.question_file_path, 'Official question paper/reference');
    for (let i = 0; i < sheet.file_paths.length; i++) await addStorageFile(sheet.file_paths[i], `Student answer sheet file ${i + 1}`);
    const prompt = `You are an assistant helping a teacher evaluate a student's written exam. Do not guess unreadable handwriting. Return JSON only, matching the schema described below.\n\nINSTITUTE: ${safeText(exam.institute_id,80)}\nSTUDENT: ${safeText(student.full_name,100)}\nCLASS: ${safeText(exam.class_name,20)}\nSUBJECT: ${safeText(exam.subject,30)}\nEXAM: ${safeText(exam.name,120)}\nMAXIMUM MARKS: ${Number(exam.max_marks)}\nMARKING SCHEME / TEACHER NOTES: ${safeText(exam.marking_scheme,10000) || 'No separate marking scheme provided. Infer cautiously from the question paper and standard curriculum.'}\nUPLOADER NOTES: ${safeText(sheet.teacher_notes,2000) || 'None'}\n\nTasks: identify each question and the student's response; compare with the reference where available; suggest marks using the provided maximum; explain what is correct, incorrect, missing, or unreadable; show expected answer or key step briefly. For mathematics and physics, award partial credit only when the visible working supports it. For chemistry, consider equations, notation and units. Do not treat uncertain handwriting as certainly wrong. Do not invent questions or student answers. Question-level marks must sum to marks_obtained, and no mark may exceed that question's max_marks. If question-level maxima cannot be confidently inferred, use null for max_marks and explain uncertainty. Overall marks must be between 0 and ${Number(exam.max_marks)}. Set confidence between 0 and 1. This is a DRAFT for teacher review, never a final decision.\n\nReturn this JSON shape: {"marks_obtained": number, "max_marks": ${Number(exam.max_marks)}, "confidence": number, "overall_feedback": string, "question_feedback": [{"question_number": string, "max_marks": number|null, "marks_awarded": number, "status": "correct"|"partially_correct"|"incorrect"|"missing"|"unclear", "student_answer": string, "expected_answer": string, "feedback": string}], "review_flags": [string]}. Do not include markdown fences.`;
    parts.unshift({ text: prompt });
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(geminiKey)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseMimeType: 'application/json', temperature: 0.1 } }),
    });
    const aiPayload = await response.json();
    if (!response.ok) throw new Error(`Gemini request failed (${response.status}): ${safeText(aiPayload?.error?.message || 'AI provider error',300)}`);
    const raw = aiPayload?.candidates?.[0]?.content?.parts?.map((p: {text?:string})=>p.text||'').join('');
    if (!raw) throw new Error('AI returned an empty evaluation.');
    let evaluation: any;
    try { evaluation = JSON.parse(raw); } catch { throw new Error('AI returned an unreadable result. Please retry.'); }
    const maxMarks = Number(exam.max_marks);
    const marks = Number(evaluation.marks_obtained);
    if (!Number.isFinite(marks) || marks < 0 || marks > maxMarks) throw new Error('AI returned marks outside the allowed range.');
    const questions = Array.isArray(evaluation.question_feedback) ? evaluation.question_feedback.slice(0,100).map((q: any) => ({
      question_number: safeText(q.question_number,30), max_marks: q.max_marks == null ? null : Math.max(0, Number(q.max_marks) || 0),
      marks_awarded: Math.max(0, Number(q.marks_awarded) || 0), status: ['correct','partially_correct','incorrect','missing','unclear'].includes(q.status) ? q.status : 'unclear',
      student_answer: safeText(q.student_answer,3000), expected_answer: safeText(q.expected_answer,3000), feedback: safeText(q.feedback,3000),
    })) : [];
    const { error: resultError } = await admin.from('results').upsert({
      institute_id: sheet.institute_id, answer_sheet_id: sheet.id, exam_id: sheet.exam_id, student_id: sheet.student_id,
      marks_obtained: marks, max_marks: maxMarks, confidence: Math.max(0, Math.min(1, Number(evaluation.confidence) || 0)),
      overall_feedback: safeText(evaluation.overall_feedback,5000), question_feedback: questions, status: 'needs_review', reviewed_by: null, reviewed_at: null,
    }, { onConflict: 'answer_sheet_id' });
    if (resultError) throw new Error(`Could not save evaluation: ${resultError.message}`);
    await admin.from('answer_sheets').update({ status: 'needs_review', processing_finished_at: new Date().toISOString(), error_message: null }).eq('id', sheet.id);
    return json({ success: true, status: 'needs_review', message: 'Draft evaluation completed. Teacher review is required.', review_flags: Array.isArray(evaluation.review_flags) ? evaluation.review_flags.slice(0,20).map((x:unknown)=>safeText(x,300)) : [] });
  } catch (error) {
    const message = safeText((error as Error)?.message || 'Evaluation failed.', 700);
    await admin.from('answer_sheets').update({ status: 'failed', processing_finished_at: new Date().toISOString(), error_message: message }).eq('id', sheet.id);
    return json({ error: message }, 500);
  }
});
