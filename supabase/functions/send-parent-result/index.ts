import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const corsHeaders = { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods':'POST, OPTIONS' };
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...corsHeaders,'Content-Type':'application/json'}});
Deno.serve(async(req)=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:corsHeaders});
  if(req.method!=='POST')return json({error:'Method not allowed'},405);
  const url=Deno.env.get('SUPABASE_URL')!,anon=Deno.env.get('SUPABASE_ANON_KEY')!,service=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const auth=req.headers.get('Authorization');if(!auth)return json({error:'Sign in required.'},401);
  const userClient=createClient(url,anon,{global:{headers:{Authorization:auth}}});const {data:ud,error:ue}=await userClient.auth.getUser();if(ue||!ud.user)return json({error:'Invalid session.'},401);
  const admin=createClient(url,service,{auth:{persistSession:false}});let resultId='';try{resultId=String((await req.json()).result_id||'')}catch{return json({error:'Invalid JSON body.'},400)}if(!resultId)return json({error:'result_id is required.'},400);
  const {data:r,error:re}=await admin.from('results').select('*,students(full_name,parent_name,parent_phone),exams(name,subject,class_name,max_marks)').eq('id',resultId).single();if(re||!r)return json({error:'Result not found.'},404);
  const {data:membership}=await admin.from('institute_memberships').select('role').eq('institute_id',r.institute_id).eq('user_id',ud.user.id).maybeSingle();if(!membership)return json({error:'You do not have access to this result.'},403);
  if(r.status!=='published')return json({error:'Only teacher-approved published results can be sent to parents.'},409);
  const recipient=String(r.students?.parent_phone||'').replace(/[\s()-]/g,'');if(!recipient)return json({error:'Parent phone number is missing.'},400);
  const {data:notification,error:ne}=await admin.from('notifications').insert({institute_id:r.institute_id,result_id:r.id,student_id:r.student_id,channel:'whatsapp',recipient,status:'queued',created_by:ud.user.id}).select().single();if(ne)return json({error:ne.message},500);
  const token=Deno.env.get('WHATSAPP_ACCESS_TOKEN'),phoneId=Deno.env.get('WHATSAPP_PHONE_NUMBER_ID'),template=Deno.env.get('WHATSAPP_TEMPLATE_NAME'),language=Deno.env.get('WHATSAPP_LANGUAGE_CODE')||'en';
  if(!token||!phoneId||!template){await admin.from('notifications').update({status:'not_configured',error_message:'Set WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_TEMPLATE_NAME secrets.'}).eq('id',notification.id);return json({success:false,mode:'manual_fallback',delivery_status:'not_configured',message:'WhatsApp Business Platform is not configured. No message was sent.',notification_id:notification.id});}
  const name=String(r.students?.parent_name||'Parent').slice(0,80),student=String(r.students?.full_name||'Student').slice(0,100),exam=String(r.exams?.name||'Exam').slice(0,100),subject=String(r.exams?.subject||'').slice(0,40),marks=String(r.marks_obtained),max=String(r.max_marks),pct=(Number(r.marks_obtained)/Math.max(1,Number(r.max_marks))*100).toFixed(1)+'%';
  try{
    // This requires an approved WhatsApp template whose body variables follow this order:
    // parent name, student name, exam name, subject, marks, maximum marks, percentage.
    const resp=await fetch(`https://graph.facebook.com/v23.0/${phoneId}/messages`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',to:recipient,type:'template',template:{name:template,language:{code:language},components:[{type:'body',parameters:[{type:'text',text:name},{type:'text',text:student},{type:'text',text:exam},{type:'text',text:subject},{type:'text',text:marks},{type:'text',text:max},{type:'text',text:pct}]}]}})});
    const data=await resp.json();if(!resp.ok)throw new Error(String(data?.error?.message||'WhatsApp provider rejected the request.').slice(0,500));
    await admin.from('notifications').update({status:'sent',provider_message_id:data?.messages?.[0]?.id||null,sent_at:new Date().toISOString(),error_message:null}).eq('id',notification.id);
    return json({success:true,delivery_status:'sent',notification_id:notification.id,provider_message_id:data?.messages?.[0]?.id||null,message:'WhatsApp result summary submitted. Delivery confirmation may arrive later.'});
  }catch(error){const msg=String((error as Error).message||'WhatsApp send failed.').slice(0,500);await admin.from('notifications').update({status:'failed',error_message:msg}).eq('id',notification.id);return json({error:msg,notification_id:notification.id},502);}
});
