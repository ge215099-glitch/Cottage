#!/usr/bin/env python3
"""生成 Cottage 应用图标 build/icon.ico。

为什么是脚本而不是一张二进制图：
  electron-builder 需要 .ico（Windows）且最低 256×256。把图标做成可复现的脚本，
  改配色时不用手工重画，也避免"仓库里躺一个来路不明的二进制"。

用法：
  python scripts/make-icon.py
产出（写在 build/，因为 electron-builder 默认就去那里找）：
  build/icon.ico   （含 16/24/32/48/64/128/256 多档，Windows 各场景各取所需）
  build/icon.png   （256×256，供预览与其它平台使用）
"""
from PIL import Image, ImageDraw

# 与 src/renderer/styles/tokens.css 的暖色调呼应，但对比度调到小尺寸下也认得出
ROOF = (176, 96, 66)        # 陶土棕屋顶
ROOF_DARK = (140, 72, 48)   # 屋檐阴影
WALL = (247, 240, 228)      # 米白墙面
WALL_LINE = (214, 199, 180)  # 墙缝
DOOR = (120, 78, 52)        # 木门
WINDOW = (109, 160, 168)    # 窗（青蓝，和屋顶形成冷暖对比）
CHIMNEY = (150, 84, 58)
GROUND = (150, 158, 132)    # 一小截地平线，避免房子"飘着"

SIZE = 1024  # 先大尺寸绘制，再降采样到各档，边缘更干净


def draw_icon() -> Image.Image:
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 画布内边距：Windows 图标习惯四周留白，贴边会显得挤
    pad = SIZE * 0.09
    left, right = pad, SIZE - pad
    ground_y = SIZE - pad

    # ---- 地平线 ----
    d.rounded_rectangle(
        [left, ground_y - SIZE * 0.035, right, ground_y],
        radius=SIZE * 0.02,
        fill=GROUND,
    )

    # ---- 烟囱（先画，被屋顶压住底部） ----
    chimney_w = SIZE * 0.085
    chimney_x = right - SIZE * 0.30
    chimney_top = pad + SIZE * 0.085
    d.rectangle(
        [chimney_x, chimney_top, chimney_x + chimney_w, chimney_top + SIZE * 0.20],
        fill=CHIMNEY,
    )

    # ---- 屋顶：等腰三角，出檐略宽于墙体 ----
    roof_apex_y = pad + SIZE * 0.10
    roof_base_y = pad + SIZE * 0.485
    eave = SIZE * 0.045
    apex_x = (left + right) / 2
    d.polygon(
        [
            (apex_x, roof_apex_y),
            (right + eave, roof_base_y),
            (left - eave, roof_base_y),
        ],
        fill=ROOF,
    )
    # 屋檐下沿的一道深色，让屋顶有厚度
    d.rectangle(
        [left - eave, roof_base_y - SIZE * 0.030, right + eave, roof_base_y],
        fill=ROOF_DARK,
    )

    # ---- 墙体 ----
    wall_top = roof_base_y
    wall_left = left + SIZE * 0.055
    wall_right = right - SIZE * 0.055
    d.rectangle([wall_left, wall_top, wall_right, ground_y], fill=WALL)
    # 墙体顶部一道浅缝
    d.rectangle(
        [wall_left, wall_top, wall_right, wall_top + SIZE * 0.012],
        fill=WALL_LINE,
    )

    # ---- 门（居中偏下，贴地） ----
    door_w = SIZE * 0.145
    door_h = SIZE * 0.215
    door_x = apex_x - door_w / 2
    d.rounded_rectangle(
        [door_x, ground_y - door_h, door_x + door_w, ground_y],
        radius=SIZE * 0.018,
        fill=DOOR,
    )

    # ---- 窗：门左右各一扇方窗 ----
    # 早先版本是"门正上方一个圆窗"，实测有两个毛病：
    #   1) 圆窗与弧形门头上下相连，整体读起来像"一个人"而不是房子；
    #   2) 缩到 32px 以下时圆形细节糊成一团，只剩一个点。
    # 方窗在小尺寸下靠直角轮廓还能认出是窗，且左右分列不会和门连体。
    win = SIZE * 0.105
    win_top = wall_top + SIZE * 0.075
    gap = SIZE * 0.055  # 窗与门之间的留缝
    for cx in (door_x - gap - win / 2, door_x + door_w + gap + win / 2):
        d.rectangle(
            [cx - win / 2, win_top, cx + win / 2, win_top + win],
            fill=WINDOW,
        )

    return img


def main() -> None:
    from pathlib import Path

    # 脚本在 scripts/，产物写仓库根的 build/
    out_dir = Path(__file__).resolve().parent.parent / "build"
    out_dir.mkdir(parents=True, exist_ok=True)
    img = draw_icon()

    png_path = out_dir / "icon.png"
    img.resize((256, 256), Image.LANCZOS).save(png_path)

    ico_path = out_dir / "icon.ico"
    sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    img.save(ico_path, format="ICO", sizes=sizes)

    print(f"wrote {png_path}")
    print(f"wrote {ico_path}")


if __name__ == "__main__":
    main()
