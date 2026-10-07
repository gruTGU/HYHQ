'use strict';
function configFromEnvironment(env = process.env, deployment = {}) {
  const integer = (name, fallback, max) => { const value = env[name]; return value === undefined || value === '' ? fallback : /^\d+$/.test(value) ? Math.min(+value, max) : 0; };
  const reminderDeployment = deployment.weatherReminders || {};
  const reminderState = env.HYHQ_WEATHER_REMINDERS_STATE || reminderDeployment.state || 'trial';
  return {
    appId: env.HYHQ_APP_ID || deployment.appId || '',
    sessionSecret: env.HYHQ_SESSION_SECRET || '',
    llmEnabled: env.HYHQ_LLM_ENABLED === 'true', llmGatewayEnabled: env.HYHQ_LLM_ENABLED === 'true',
    deepseekApiKey: env.DEEPSEEK_API_KEY || '',
    llmDailyLimit: integer('HYHQ_LLM_DAILY_LIMIT', 5, 5),
    llmPerUserAttemptLimit: integer('HYHQ_LLM_USER_ATTEMPTS', 10, 10),
    llmGlobalAttemptLimit: integer('HYHQ_LLM_GLOBAL_ATTEMPTS', 200, 200),
    llmGlobalTokenLimit: integer('HYHQ_LLM_GLOBAL_TOKENS', 1000000, 1000000),
    llmMaxOutputTokens: integer('HYHQ_LLM_MAX_OUTPUT_TOKENS', 600, 1000),
    llmTimeoutSeconds: integer('HYHQ_LLM_TIMEOUT_SECONDS', 35, 40), llmMaxConcurrency: 1,
    qweatherEnabled: env.HYHQ_QWEATHER_ENABLED === 'true', qweatherApiKey: env.QWEATHER_API_KEY || '',
    qweatherApiHost: env.QWEATHER_API_HOST || '',
    qweatherMonthlyLimit: integer('HYHQ_QWEATHER_MONTHLY_LIMIT', 0, 30000),
    qweatherBudgetConfirmed: env.HYHQ_QWEATHER_BUDGET_CONFIRMED === 'true',
    inferenceEnabled: env.HYHQ_INFERENCE_ENABLED === 'true' || deployment.inferenceEnabled === true,
    modelRoot: env.HYHQ_MODEL_ROOT || undefined,
    management: { enabled: env.HYHQ_MANAGEMENT_ENABLED === 'true', adminUserIds: String(env.HYHQ_ADMIN_USER_IDS || '').split(',').map(value => value.trim()).filter(value => /^[a-f0-9-]{36}$/.test(value)) },
    community: { enabled: env.HYHQ_COMMUNITY_ENABLED === 'true', qualificationConfirmed: env.HYHQ_COMMUNITY_QUALIFIED === 'true',
      qualificationReference: env.HYHQ_COMMUNITY_QUALIFICATION_REFERENCE || '', qualificationDate: env.HYHQ_COMMUNITY_QUALIFICATION_DATE || '',
      moderationReady: env.HYHQ_COMMUNITY_MODERATION_READY === 'true' },
    weatherReminders: { enabled: env.HYHQ_WEATHER_REMINDERS_ENABLED === undefined || env.HYHQ_WEATHER_REMINDERS_ENABLED === ''
      ? reminderDeployment.enabled === true : env.HYHQ_WEATHER_REMINDERS_ENABLED === 'true',
      templateId: env.HYHQ_WEATHER_REMINDERS_TEMPLATE_ID || reminderDeployment.templateId || '',
      state: ['developer', 'trial', 'formal'].includes(reminderState) ? reminderState : '' },
    maintenanceEnabled: env.HYHQ_MAINTENANCE_ENABLED === 'true' || deployment.maintenanceEnabled === true,
    deploymentEnv: typeof deployment.env === 'string' ? deployment.env : '',
    recognitionDailyLimit: 20, recognitionGlobalDailyLimit: 200, inferenceMaxConcurrency: 1, inferenceTimeoutSeconds: 35,
  };
}
module.exports = { configFromEnvironment };
