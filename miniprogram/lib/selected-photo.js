// A retry draft is only the local photo chosen on this page. Server thumbnails,
// results, locations and account history must still be cleared after expiry.
function selectedPhotoIdentity(session) {
  const current = session.get();
  return { userId: current && current.user && current.user.id, revision: typeof session.revision === 'function' ? session.revision() : 0 };
}
function canAcceptSelectedPhoto(identity, session) {
  if (!identity || !identity.userId) return false;
  const current = session.get();
  const invalidation = typeof session.invalidation === 'function' && session.invalidation();
  if (invalidation && invalidation.reason === 'logout' && invalidation.revision > identity.revision) return false;
  if (current) return !!(current.user && current.user.id === identity.userId);
  return !!(invalidation && invalidation.reason === 'expired' && invalidation.userId === identity.userId);
}
function rememberSelectedPhoto(page, session, identity = selectedPhotoIdentity(session)) {
  page._photoOwner = identity.userId;
  page._photoRevision = identity.revision;
}
function canKeepSelectedPhoto(page, session) {
  if (page.data.imageOrigin !== 'selected' || !page.data.imagePath || !page._photoOwner) return false;
  return canAcceptSelectedPhoto({ userId: page._photoOwner, revision: page._photoRevision }, session);
}
function expiredPhotoNotice(page) {
  return page.data.imageOrigin === 'selected' && page.data.imagePath
    ? '登录已失效，照片已保留在本页。请重新登录后再次提交。'
    : '登录已失效，请重新登录后继续。';
}
module.exports = { selectedPhotoIdentity, canAcceptSelectedPhoto, rememberSelectedPhoto, canKeepSelectedPhoto, expiredPhotoNotice };
