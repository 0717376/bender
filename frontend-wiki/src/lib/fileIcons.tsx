import {
  File as FileIcon, FileText, Image as ImageIcon, FileAudio, FileVideo, FileArchive,
} from 'lucide-react'

const EXT_ICONS: [RegExp, React.ComponentType<{ size?: number }>][] = [
  [/\.(png|jpe?g|gif|webp|heic|svg|bmp)$/i, ImageIcon],
  [/\.(mp3|ogg|wav|m4a|flac)$/i, FileAudio],
  [/\.(mp4|mov|mkv|webm|avi)$/i, FileVideo],
  [/\.(zip|rar|7z|tar|gz)$/i, FileArchive],
  [/\.(md|txt|pdf|docx?|xlsx?|pptx?|csv)$/i, FileText],
]

export function fileIcon(name: string, size = 15) {
  const Ico = EXT_ICONS.find(([re]) => re.test(name))?.[1] ?? FileIcon
  return <Ico size={size} />
}
