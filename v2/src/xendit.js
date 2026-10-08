import crypto from 'node:crypto';

const BASE_URL='https://api.xendit.co';

function authHeader(apiKey){
  return 'Basic '+Buffer.from(String(apiKey)+':').toString('base64');
}

function assertConfigured(apiKey){
  if(!apiKey) throw Object.assign(new Error('xendit_api_key_missing'),{code:'payment_adapter_unavailable',status:503});
}

async function request(path,{apiKey,method='GET',body,headers={}}={}){
  assertConfigured(apiKey);
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),15000);
  try{
    const r=await fetch(BASE_URL+path,{method,signal:controller.signal,headers:{
      Authorization:authHeader(apiKey),'Content-Type':'application/json',Accept:'application/json',...headers
    },body:body===undefined?undefined:JSON.stringify(body)});
    const text=await r.text();
    let data=null;try{data=text?JSON.parse(text):null}catch{data={raw:text}}
    if(!r.ok)throw Object.assign(new Error(data?.message||data?.error_code||'xendit_request_failed'),{code:data?.error_code||'xendit_request_failed',status:r.status,data});
    return data;
  }catch(error){
    if(Number.isInteger(error?.status))throw error;
    if(error?.name==='AbortError')throw Object.assign(new Error('xendit_timeout'),{code:'xendit_timeout',status:504});
    throw Object.assign(new Error('xendit_unavailable'),{code:'xendit_unavailable',status:503,cause:error});
  }finally{clearTimeout(timer)}
}

function action(data,descriptor){
  return (Array.isArray(data?.actions)?data.actions:[]).find(x=>x.descriptor===descriptor)?.value||null;
}

export function createXendit({apiKey,apiVersion='2025-09-01'}){
  return {
    configured:Boolean(apiKey),
    async paymentRequest(input){
      const referenceId=String(input.referenceId);
      const body={reference_id:referenceId,type:'PAY',country:'ID',currency:'IDR',request_amount:Number(input.amount),capture_method:'AUTOMATIC',channel_code:String(input.channelCode),channel_properties:input.channelProperties||{},description:String(input.description||'BrandalBet deposit').slice(0,1000),metadata:{...(input.metadata||{}),merchant_reference:referenceId}};
      const data=await request('/v3/payment_requests',{apiKey,method:'POST',body,headers:{'api-version':'2024-11-11','Idempotency-Key':String(input.idempotencyKey||referenceId)}});
      return {raw:data,id:data?.payment_request_id||null,status:data?.status||null,paymentUrl:action(data,'WEB_URL')||action(data,'DEEPLINK_URL'),qrString:action(data,'QR_STRING'),vaNumber:action(data,'VIRTUAL_ACCOUNT_NUMBER')};
    },
    async payout(input){
      const referenceId=String(input.referenceId);
      const routingType=String(input.routingType||'').trim().toUpperCase();
      const routingValue=String(input.routingValue||'').trim();
      if(!routingType||!routingValue)throw Object.assign(new Error('xendit_routing_missing'),{code:'bank_routing_unconfigured',status:400});
      const body={reference_id:referenceId,recipient:{
        type:'INDIVIDUAL',given_name:String(input.givenName||input.accountName||'Member').slice(0,50),
        surname:String(input.surname||'').slice(0,50)||undefined,relationship:'CUSTOMER',
        account_details:{currency:'IDR',account_country:'ID',account_holder_name:String(input.accountName),account_number:String(input.accountNumber),routing_type_1:routingType,routing_value_1:routingValue}
      },payout_details:{source_currency:'IDR',source_amount:Number(input.amount),destination_currency:'IDR'},
      source_of_fund:'BUSINESS_REVENUE',purpose_code:'OTHER',description:String(input.description||referenceId).slice(0,100)};
      Object.keys(body.recipient).forEach(k=>body.recipient[k]===undefined&&delete body.recipient[k]);
      const data=await request('/v3/payouts',{apiKey,method:'POST',body,headers:{'api-version':apiVersion,'idempotency-key':String(input.idempotencyKey||referenceId)}});
      return {raw:data,id:data?.payout_id||null,status:data?.status||null};
    },
    async getPaymentRequest(paymentRequestId){
      return request('/v3/payment_requests/'+encodeURIComponent(paymentRequestId),{apiKey,headers:{'api-version':'2024-11-11'}});
    },
    async getPayout(payoutId){
      return request('/v3/payouts/'+encodeURIComponent(payoutId),{apiKey,headers:{'api-version':apiVersion}});
    },
    async cancelPayout(payoutId){
      return request('/v3/payouts/'+encodeURIComponent(payoutId)+'/cancel',{apiKey,method:'POST',headers:{'api-version':apiVersion}});
    }
  };
}

export function verifyCallbackToken(supplied,expected){
  const a=Buffer.from(String(supplied||'')),b=Buffer.from(String(expected||''));
  return Boolean(expected)&&a.length===b.length&&crypto.timingSafeEqual(a,b);
}

export function payoutTerminalStatus(status){
  return ['SUCCEEDED','FAILED','REVERSED','REJECTED','CANCELLED','EXPIRED'].includes(String(status||'').toUpperCase());
}
