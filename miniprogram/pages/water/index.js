const { createSeriesPage } = require('../../lib/series');
const { entryUrl } = require('../../lib/llm');
const definition = createSeriesPage('water');
definition.data.advancedFilters = false;
definition.data.provenanceExpanded = false;
definition.toggleFilters = function () {
  if (this._interactive()) this.setData({ advancedFilters: !this.data.advancedFilters });
};
definition.toggleProvenance = function () {
  if (this._interactive()) this.setData({ provenanceExpanded: !this.data.provenanceExpanded });
};
definition.selectMetricCard = function (event) {
  if (!this._interactive() || this.data.loading || this.data.error) return;
  const index = Number(event.currentTarget.dataset.index);
  if (!this.data.view || !Number.isInteger(index) || !this.data.view.series[index]) return;
  this.changeMetric({ detail: { value: index } });
};
definition.openAI = function () {
  if (!this._interactive() || this.data.loading || this.data.error) return;
  const source = this.data.waterBodies[this.data.waterIndex];
  const url = source && entryUrl('explore', 'water', source.id);
  if (url) wx.navigateTo({ url });
};
Page(definition);
