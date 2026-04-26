# Sunny Shadow Video

## 用途

供博客 Sunny 主题作为叶影光晕背景层使用。
通过 `mix-blend-mode: multiply` 叠加在页面右上方，模拟阳光穿过树叶后的柔和投影。

## 视频标准

| 项目 | 要求 |
|------|------|
| 时长 | 6–20 秒，可无缝 loop |
| 内容 | 树叶/叶影投影到墙面或地面，不要出现真实树枝主体、天空、人物、水印 |
| 风格 | 柔和、低对比、慢速自然晃动 |
| 色调 | 暖棕灰，不要高饱和绿色 |
| 尺寸 | 1280×720 或更高，横向构图 |
| 格式 | 导出两格式：mp4（H.264）+ webm（VP9/AV1），均需 |
| 码率 | mp4 ≤ 2Mbps，webm ≤ 1.5Mbps |
| 帧率 | 24–30fps |
| 音频 | 无音频（muted） |

## 文件命名

```
sunny-shadow.mp4
sunny-shadow.webm
```

放置于当前目录 `assets/video/`。

## 素材来源建议

- Pexels / Unsplash 免费视频（搜索 "leaf shadow wall"、"dappled light"、"sunlight leaves"）
- 自拍：晴天将手机置于树下拍摄地面或白墙投影
- AI 生成：Runway / Pika "gentle leaf shadow on wall, warm light, loop"

## 当前状态

⚠️ 素材尚未放入，页面使用 CSS fallback（`#sunny-atmosphere` 仍显示暖光渐变）。
添加视频文件后刷新即可激活真实叶影效果。
