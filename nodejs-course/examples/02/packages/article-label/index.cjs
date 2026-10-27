const { decorateStatus } = require('./internal.cjs');

function formatArticleLabel(id, status) {
  return `${decorateStatus(status)} ${id}`;
}

module.exports = { formatArticleLabel };
