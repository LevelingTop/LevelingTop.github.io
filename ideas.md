# MP3 打点分割工具 - 设计方案

## 方案一：专业音频工作站风格
<response>
<text>
**Design Movement**: 专业 DAW（数字音频工作站）美学，参考 Ableton Live / Logic Pro 的暗色工作台风格
**Core Principles**:
- 深色背景，减少视觉疲劳，突出波形
- 功能密度高但层次清晰，工具栏紧凑
- 精密感：像素级对齐，单色系配合高亮色
- 数据可读性优先：时间码、波形、标记点一目了然

**Color Philosophy**: 深炭灰底色 (#1a1a1a)，波形用亮青色 (#00d4aa)，标记点用橙红 (#ff6b35)，播放头用白色
**Layout Paradigm**: 顶部工具栏 + 全宽波形区（占 60% 高度）+ 底部章节列表（可折叠）
**Signature Elements**: 网格背景波形、时间轴刻度、发光播放头
**Interaction Philosophy**: 键盘优先，鼠标辅助，所有操作有即时视觉反馈
**Animation**: 播放头平滑滑动，标记点弹入，章节列表行高亮过渡
**Typography System**: JetBrains Mono（时间码）+ Inter（UI 文字）
</text>
<probability>0.08</probability>
</response>

## 方案二：极简主义纸张质感
<response>
<text>
**Design Movement**: 日式极简主义，参考 Notion / Linear 的纸张质感
**Core Principles**:
- 米白底色，大量留白
- 排版驱动设计，内容即界面
- 去除装饰，保留功能

**Color Philosophy**: 暖白底 (#fafaf8)，墨色文字，单一强调色（靛蓝 #3b5bdb）
**Layout Paradigm**: 居中单列，波形区域有明显边框，章节列表为简洁表格
**Signature Elements**: 细线分割、章节序号大字排版、简洁图标
**Interaction Philosophy**: 轻触反馈，无过多动效
**Animation**: 淡入淡出，无弹跳
**Typography System**: Noto Serif SC（标题）+ Inter（正文）
</text>
<probability>0.05</probability>
</response>

## 方案三：工业感暗色工具台（选定）
<response>
<text>
**Design Movement**: 工业工具台美学 + 现代 SaaS 暗色主题，参考 Figma / VS Code 的精密工具感
**Core Principles**:
- 深色底色降低长时间使用疲劳
- 波形区域是视觉核心，周围元素服务于它
- 精密控制感：每个按钮都有明确的功能边界
- 信息密度适中：关键数据显眼，次要信息收起

**Color Philosophy**: 深蓝灰底 (#0f1117)，面板用 (#1c1f2e)，波形用渐变青绿 (#22d3ee → #06b6d4)，标记点用琥珀 (#f59e0b)，播放头用亮白，强调色 (#6366f1 靛紫)
**Layout Paradigm**: 左侧窄边栏（快捷键提示）+ 中央主区域（波形 + 控制）+ 右侧章节面板（可调宽）
**Signature Elements**: 
  1. 波形渐变填充（青绿色，底部渐隐）
  2. 琥珀色三角标记点（带章节序号标签）
  3. 发光播放头（白色竖线 + 上下三角 + 模糊光晕）
**Interaction Philosophy**: 拖拽优先，键盘加速，右键上下文菜单，所有操作可撤销
**Animation**: 
  - 播放头：requestAnimationFrame 平滑跟随
  - 标记点：scale + opacity 弹入（spring 曲线）
  - 章节行：hover 时左侧亮边 + 背景微亮
  - 导出按钮：加载时脉冲动画
**Typography System**: 
  - JetBrains Mono（时间码、数字）
  - Inter（UI 标签）
  - 字重：400 正文，600 强调，700 标题
</text>
<probability>0.09</probability>
</response>

---
**选定方案三：工业感暗色工具台**
