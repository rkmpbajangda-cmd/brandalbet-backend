import { ServiceError } from '../utils/errors.js';
const presets = [
 ['merchantId','Merchant ID','text'],['merchantCode','Merchant Code','text'],['storeId','Store ID','text'],['terminalId','Terminal ID','text'],
 ['clientId','Client ID','text'],['clientSecret','Client Secret','secret'],['apiKey','API Key','secret'],['apiSecret','API Secret','secret'],
 ['secretKey','Secret Key','secret'],['privateKey','Private Key','multiline'],['publicKey','Public Key','multiline'],
 ['webhookSecret','Webhook Secret','secret'],['signatureKey','Signature Key','secret'],['passphrase','Passphrase','secret'],
 ['username','Username','text'],['password','Password','secret'],['accountId','Account ID','text'],
 ['apiBaseUrl','API Base URL','url'],['callbackUrl','Callback URL','url'],['returnUrl','Return URL','url'],
];
export const FIELD_PRESETS = Object.freeze(presets.map(([id,label,kind])=>Object.freeze({id,label,kind})));
const defaultIds = ['merchantId','privateKey','apiKey','publicKey','webhookSecret'];
export const DEFAULT_CREDENTIAL_SCHEMA = Object.freeze(defaultIds.map(id=>FIELD_PRESETS.find(f=>f.id===id)));
export function validateCredentialSchema(schema) {
 if(!Array.isArray(schema)||schema.length<1||schema.length>30)throw new ServiceError('invalid_credential_schema');
 const seen=new Set();
 return schema.map(field=>{
  if(!field||typeof field!=='object'||Array.isArray(field)||Object.keys(field).some(k=>!['id','label','kind'].includes(k)))throw new ServiceError('invalid_credential_schema');
  const {id,label,kind}=field;
  if(typeof id!=='string'||!/^[A-Za-z][A-Za-z0-9_]{0,49}$/.test(id)||['constructor','prototype','__proto__'].includes(id.toLowerCase())||seen.has(id.toLowerCase()))throw new ServiceError('invalid_credential_field_id');
  if(typeof label!=='string'||!label.trim()||label.length>80||!['text','secret','multiline','url'].includes(kind))throw new ServiceError('invalid_credential_schema');
  seen.add(id.toLowerCase());return {id,label:label.trim(),kind};
 });
}
export function validateCredentialValues(values,schema){
 const definitions=new Map(schema.map(f=>[f.id,f]));
 for(const [id,value] of Object.entries(values)){
  const definition=definitions.get(id);
  if(!definition||typeof value!=='string'||value.length>12000)throw new ServiceError('invalid_payment_credentials');
  if(value&&definition.kind==='url'){
   let url;try{url=new URL(value)}catch{throw new ServiceError('invalid_payment_url')}
   if(url.protocol!=='https:'||url.username||url.password)throw new ServiceError('invalid_payment_url');
  }
 }
}
