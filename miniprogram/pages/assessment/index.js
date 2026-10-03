const { createAssessmentController } = require('./controller');
// Legacy page links retain the same permission-checked observation workflow.
Page(createAssessmentController());
