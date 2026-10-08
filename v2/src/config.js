import 'dotenv/config';
function csv(value){return String(value||'').split(',').map(v=>v.trim()).filter(Boolean)}
function num(name,fallback,min=0){const n=Number(process.env[name]??fallback);if(!Number.isFinite(n)||n<min)throw new Error(name+' must be >= '+min);return n}
export const config=Object.freeze({
 nodeEnv:process.env.NODE_ENV||'development',port:num('PORT',3000,1),databaseUrl:String(process.env.DATABASE_URL||'').trim(),
 databaseConnectionLimit:num('DATABASE_CONNECTION_LIMIT',10,2),sessionTtlDays:num('SESSION_TTL_DAYS',30,1),
 corsOrigins:csv(process.env.CORS_ORIGINS),bodyLimit:process.env.BODY_LIMIT||'256kb',requestTimeoutMs:num('REQUEST_TIMEOUT_MS',15000,1000),
 trustProxy:process.env.TRUST_PROXY==='true',providerBaseUrl:(process.env.GOLDSLOTPALASE_API_BASE||'https://agent.goldslotpalase.com').replace(/\/+$/,''),
 providerToken:process.env.GOLDSLOTPALASE_API_TOKEN||'',providerCallbackToken:process.env.GOLDSLOTPALASE_CALLBACK_TOKEN||'',
 providerTimeoutMs:num('PROVIDER_TIMEOUT_MS',12000,1000),paymentBaseUrl:(process.env.PAYMENT_API_BASE||'').replace(/\/+$/,''),
 paymentApiKey:process.env.PAYMENT_API_KEY||'',paymentApiSecret:process.env.PAYMENT_API_SECRET||'',paymentWebhookSecret:process.env.PAYMENT_WEBHOOK_SECRET||'',
 xenditApiKey:process.env.XENDIT_API_KEY||'',xenditApiVersion:process.env.XENDIT_API_VERSION||'2025-09-01',xenditWebhookToken:process.env.XENDIT_WEBHOOK_TOKEN||'',xenditDefaultChannel:process.env.XENDIT_DEFAULT_CHANNEL||'QRIS',xenditBankRoutingType:process.env.XENDIT_BANK_ROUTING_TYPE||'SWIFT',
 paymentProvider:process.env.PAYMENT_PROVIDER||'',paymentVaultKey:process.env.PAYMENT_VAULT_KEY||'',minDeposit:num('MIN_DEPOSIT_IDR',20000,0),minWithdrawal:num('MIN_WITHDRAWAL_IDR',50000,0),
 masterBootstrapToken:process.env.BOOTSTRAP_SUPERADMIN_TOKEN||'',memberOrigins:csv(process.env.MEMBER_ORIGINS||'https://brandalbet.blogspot.com'),
 backofficeOrigins:csv(process.env.BACKOFFICE_ORIGINS||'https://backoffic.blogspot.com')
});
if(!config.databaseUrl)throw new Error('Missing required environment variable: DATABASE_URL');
if(!Number.isInteger(config.port)||config.port>65535)throw new Error('PORT must be a valid TCP port');