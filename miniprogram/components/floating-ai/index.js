const releasePolicy = require('../../lib/release-policy');
Component({
  data: { releaseEnabled: releasePolicy.generativeQAEnabled },
  properties: { visible: { type: Boolean, value: true }, tabPage: { type: Boolean, value: false }, label: { type: String, value: '问问 AI' } },
  methods: { open() { if (releasePolicy.generativeQAEnabled && this.data.visible) this.triggerEvent('open'); } },
});
