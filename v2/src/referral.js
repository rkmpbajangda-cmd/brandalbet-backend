export function normalizeReferralCode(value){
 const code=String(value??'').trim().toUpperCase();
 if(!code)return null;
 if(!/^[A-Z0-9_-]{4,32}$/.test(code))throw Object.assign(new Error('invalid_referral_code'),{code:'invalid_referral_code',status:400});
 return code;
}
