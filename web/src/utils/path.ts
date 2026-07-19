// 取路径最后一段作为文件名，兼容 Unix 和 Windows 路径分隔符
export function getFileName(path: string): string {
  return path.split(/[/\\]/).pop() || path
}
