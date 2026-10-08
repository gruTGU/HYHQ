Component({
  properties: { loading: Boolean, error: String, empty: Boolean, emptyText: { type: String, value: '暂无数据，稍后再来看看' }, emptyImage: { type: String, value: '' }, appearance: { type: String, value: 'forest' } },
  data: { imageFailed: false },
  observers: { emptyImage() { this.setData({ imageFailed: false }); } },
  methods: { retry() { this.triggerEvent('retry'); }, imageError() { if (!this.data.imageFailed) this.setData({ imageFailed: true }); } },
});
