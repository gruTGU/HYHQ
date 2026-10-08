# Finder 启动 .command 时可能没有继承 nvm 的 Node 路径。
if ! command -v node >/dev/null 2>&1; then
  if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
    source "$HOME/.nvm/nvm.sh"
  fi
fi
if ! command -v node >/dev/null 2>&1; then
  print '请先安装 Node.js 20.19 或更新版本。'
  read '?按回车退出'
  exit 1
fi
