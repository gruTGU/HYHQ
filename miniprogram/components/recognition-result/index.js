Component({
  properties: { result: Object, reportEnabled: { type: Boolean, value: false }, busy: { type: Boolean, value: false } },
  methods: {
    content(event) { this.triggerEvent('content', { id: event.currentTarget.dataset.id }); },
    retake() { this.triggerEvent('retake'); },
    environment() { if (this.properties.reportEnabled && !this.properties.busy) this.triggerEvent('environment'); },
  },
});
