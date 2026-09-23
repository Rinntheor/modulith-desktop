// src-tauri/src/modules/desktop/tray_menu.rs
//
// 自绘托盘菜单：一个无边框、透明、始终置顶的小窗口。
//
// ============================================================
// 为什么不用原生菜单
// ============================================================
//
// Tauri 的 `Menu` API 只能往**系统原生菜单**里加项：字号、圆角、悬停配色、
// 分隔线样式全部由系统画。要做到与应用一致的观感（圆角、投影、悬停高亮、
// 进入动画、跟随深浅色），只能自己画 —— 而"自己画"意味着一个真正的窗口，
// 因为菜单必须能显示在主窗口**之外**（主窗口可能已被隐藏到托盘）。
//
// 代价要如实说：这是一个额外的 WebView 窗口，弹一次就多一份渲染进程开销。
// 因此它**按需创建**（第一次右键才建），而不是常驻。
//
// ============================================================
// 定位：为什么在 Rust 侧算，而不是在前端
// ============================================================
//
// 窗口的位置必须在**显示之前**定好，否则用户会看到它先在屏幕中间闪一下、
// 再跳到托盘旁边。前端做不到这件事：它要等窗口显示、页面加载完才知道自己
// 该在哪 —— 那时已经晚了。
//
// 因此位置完全在后端算：拿光标位置（右键就在光标处），减去要显示的那一条边，
// 再按显示器工作区钳制。
//
// ============================================================
// 为什么这个文件里的调用都不会死锁
// ============================================================
//
// `tray.rs` 的文件头写过那条判据：**只有会等事件循环的调用**在事件回调里
// 才会死锁。这里从托盘回调里调用的全部是"发完就走"的：`set_position`、
// `show`、`set_focus`、`hide`。`cursor_position()` 也只是读一个系统值
// （它不走窗口的 dispatcher），因此同样安全。
//
// 反过来，任何读窗口状态的调用（`is_visible`、`is_minimized`）都会经
// dispatcher 等回复 —— 这个文件里一处都没有用，这不是巧合。

use tauri::{PhysicalPosition, WebviewWindow};

use crate::prelude::*;

/// 托盘菜单窗口的标签。与 `tauri.conf.json` 里的 `label` 必须一致。
pub const TRAY_MENU_LABEL: &str = "tray-menu";

/// 主窗口标签
pub const MAIN_WINDOW: &str = "main";

/// 菜单窗口相对光标的偏移（物理像素）。
///
/// 托盘图标在屏幕右下角，因此菜单显示在光标的**左上方**：右边缘与光标对齐，
/// 下边缘在光标上方一点。留 8px 是为了让菜单不压在托盘图标上 ——
/// 压在图标上会让用户看不清自己是点到了哪一个。
const CURSOR_OFFSET: i32 = 8;

/// 从托盘图标的位置推出菜单应该放在哪里。
///
/// 抽成纯函数（输入输出都是纯粹的数）以便单元测试覆盖 —— 定位是这类窗口最容易
/// 错的部分（差一个偏移就跑到屏幕外），而它恰好在没有图形环境时也算得出来。
///
/// `cursor`：光标（或托盘图标）在屏幕坐标系里的位置。
/// `size`：菜单窗口的尺寸（物理像素）。
/// `work_area`：显示器的工作区（`(x, y, width, height)`，物理像素）。
///
/// 返回菜单窗口左上角的位置。
///
/// 钳制逻辑是这里真正的价值：托盘通常贴着屏幕右下角，因此"左上方向"的默认
/// 摆放会把菜单推出屏幕外 —— 那种表现是"右键点了一下，什么都没出现"，
/// 而窗口其实好好地显示在屏幕外面。
pub fn position_for(
    cursor: (i32, i32),
    size: (u32, u32),
    work_area: (i32, i32, u32, u32),
) -> (i32, i32) {
    let (cx, cy) = cursor;
    let (w, h) = (size.0 as i32, size.1 as i32);
    let (wx, wy, ww, wh) = (work_area.0, work_area.1, work_area.2 as i32, work_area.3 as i32);

    // 默认：菜单的右下角贴在光标的左上方。
    let mut x = cx - w + CURSOR_OFFSET;
    let mut y = cy - h - CURSOR_OFFSET;

    // 左边界不够时改成向右展开。
    if x < wx {
        x = cx - CURSOR_OFFSET;
    }
    // 下边界不够时改成向下展开（任务栏不在底部的情形，或光标在半屏）。
    if y < wy {
        y = cy + CURSOR_OFFSET;
    }

    // 最后再按工作区钳制一次。**这是必须的兜底**：上面两次展开都可能仍然越界
    // （例如工作区本身比菜单还窄）。宁可让菜单贴边，也不要让它跑到看不见的地方。
    let max_x = wx + (ww - w).max(0);
    let max_y = wy + (wh - h).max(0);
    x = x.clamp(wx, max_x);
    y = y.clamp(wy, max_y);

    (x, y)
}

/// 找到菜单窗口（不存在时返回 `None`）
fn menu_window(app: &AppHandle) -> Option<WebviewWindow> {
    use tauri::Manager;
    app.get_webview_window(TRAY_MENU_LABEL)
}

/// 在光标处显示菜单。
///
/// 返回 `Err` 的原因字符串由调用方记日志：从托盘回调里失败时，日志是唯一的线索。
pub fn show(app: &AppHandle) -> Result<(), String> {
    let window = menu_window(app).ok_or_else(|| "托盘菜单窗口不存在".to_string())?;

    // 光标位置。取不到时**不显示**（返回 Err）而不是显示在某个默认位置 ——
    // 一个出现在屏幕中央的托盘菜单比不出来更让人困惑。
    //
    // `cursor_position()` 给的是 `f64`（Tauri 的这个 API 跨平台共用，
    // 而 macOS 的屏幕坐标确实是浮点的）。这里四舍五入成整数：
    // 窗口位置本来就是整数，而直接 `as i32` 会向下取整 —— 在负坐标上
    // 那会变成"更靠左"，表现为菜单比预期偏一点。
    let cursor = app
        .cursor_position()
        .map_err(|e| format!("无法取得光标位置：{e}"))?;
    let cursor = (cursor.x.round() as i32, cursor.y.round() as i32);

    let size = window
        .outer_size()
        .map_err(|e| format!("无法取得菜单窗口尺寸：{e}"))?;

    // 用**光标所在显示器**的工作区，而不是主显示器：多显示器下托盘可能在任何
    // 一块上，用主显示器的工作区去钳制会把菜单放到另一块屏幕上去。
    let work_area = match window.current_monitor() {
        Ok(Some(monitor)) => {
            let area = monitor.work_area();
            (area.position.x, area.position.y, area.size.width, area.size.height)
        }
        Ok(None) => {
            // 拿不到显示器信息：退化成"不钳制"，位置仍然按光标算。
            // 这比不显示好 —— 绝大多数情况下光标就在工作区里。
            (i32::MIN / 4, i32::MIN / 4, u32::MAX / 4, u32::MAX / 4)
        }
        Err(error) => {
            log::warn!("托盘菜单：读取显示器信息失败，将不做边界钳制：{error}");
            (i32::MIN / 4, i32::MIN / 4, u32::MAX / 4, u32::MAX / 4)
        }
    };

    let (x, y) = position_for(cursor, (size.width, size.height), work_area);

    // 顺序很重要：**先摆好位置再显示**。反过来的话，用户会看到菜单在旧位置
    // （通常是上次弹出的地方）闪一下再跳过去。
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| format!("无法移动托盘菜单窗口：{e}"))?;

    window
        .show()
        .map_err(|e| format!("无法显示托盘菜单窗口：{e}"))?;

    // 聚焦是必需的：没有焦点，`WindowEvent::Focused(false)` 就不会触发，
    // 于是"点别处关闭菜单"这条路径失效，菜单会一直挂在屏幕上。
    window
        .set_focus()
        .map_err(|e| format!("无法聚焦托盘菜单窗口：{e}"))?;

    Ok(())
}

/// 隐藏菜单（幂等）
pub fn hide(app: &AppHandle) {
    let Some(window) = menu_window(app) else {
        return;
    };
    if let Err(error) = window.hide() {
        log::warn!("托盘菜单：隐藏失败：{error}");
    }
}

/// 装上"失去焦点就收起来"的行为。
///
/// 这是托盘菜单的**核心交互**：点别处 = 关掉菜单。少了它，菜单会一直挂在
/// 屏幕上挡住别的东西，而用户唯一的办法是再点一次托盘图标。
///
/// 这里从窗口事件回调里调用 `hide()` 是安全的 —— 判据见文件头
/// （"发完就走"的调用不会与事件循环互等）。
pub fn install(app: &AppHandle) {
    let Some(window) = menu_window(app) else {
        // 窗口配置没生效（label 写错、或配置没被读到）。如实记日志：
        // 少了这一步的表现是"点别处菜单不关"，排查时没有任何线索。
        log::warn!("托盘菜单窗口不存在，自绘菜单不可用（检查 tauri.conf.json 的 label）");
        return;
    };

    let handle = app.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Focused(false) = event {
            hide(&handle);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一个 1920×1080 的工作区，起点在原点，方便算账。
    const DESKTOP: (i32, i32, u32, u32) = (0, 0, 1920, 1080);
    const MENU: (u32, u32) = (268, 316);

    /// 光标在屏幕右下角（托盘的典型位置）时，菜单要在**屏幕内**的左上方。
    ///
    /// 这是最主要的一条：托盘就贴着右下角，如果按"左上方向"直接摆，
    /// 菜单会有一部分跑到屏幕外 —— 那正是这个方法不能只做减法的原因。
    #[test]
    fn a_bottom_right_cursor_keeps_the_menu_on_screen() {
        let (x, y) = position_for((1900, 1070), MENU, DESKTOP);

        assert!(x >= 0, "菜单左边缘不能跑到屏幕外：x={x}");
        assert!(y >= 0, "菜单上边缘不能跑到屏幕外：y={y}");
        assert!(x + MENU.0 as i32 <= 1920, "菜单右边缘越界：{}", x + MENU.0 as i32);
        assert!(y + MENU.1 as i32 <= 1080, "菜单下边缘越界：{}", y + MENU.1 as i32);
    }

    /// 正常情况下（光标离右下角很远）菜单在光标的**上方且右对齐**。
    ///
    /// 这条钉住的是"默认摆放方向"，因为上面那条钳制会把越界的情况盖掉 ——
    /// 只测钳制的话，把默认方向写反了也测不出来。
    #[test]
    fn the_default_placement_is_above_and_right_aligned_with_the_cursor() {
        let cursor = (1000, 600);
        let (x, y) = position_for(cursor, MENU, DESKTOP);

        assert_eq!(
            x + MENU.0 as i32,
            cursor.0 + CURSOR_OFFSET,
            "右边缘应当与光标对齐（差一个偏移）"
        );
        assert_eq!(
            y + MENU.1 as i32,
            cursor.1 - CURSOR_OFFSET,
            "下边缘应当在光标上方（差一个偏移）"
        );
    }

    /// 左边界不够时向右展开，而不是被钳制到贴着屏幕左边缘。
    ///
    /// 这两者的区别是可见的：向右展开时菜单紧挨着光标；单纯钳制会让菜单
    /// 与光标之间隔着一大段距离，看起来像是"点错了地方"。
    #[test]
    fn a_cursor_near_the_left_edge_flips_the_menu_to_the_right() {
        let cursor = (10, 600);
        let (x, _) = position_for(cursor, MENU, DESKTOP);

        assert_eq!(x, cursor.0 - CURSOR_OFFSET, "应当改为向右展开");
    }

    /// 上边界不够时向下展开。
    #[test]
    fn a_cursor_near_the_top_edge_flips_the_menu_downwards() {
        let cursor = (1000, 10);
        let (_, y) = position_for(cursor, MENU, DESKTOP);

        assert_eq!(y, cursor.1 + CURSOR_OFFSET, "应当改为向下展开");
    }

    /// **工作区不在原点时也要正确**（副显示器、任务栏在左侧的情形）。
    ///
    /// 这条防的是"把坐标当成从 0 开始"的写法：那种写法在主显示器上碰巧正确，
    /// 而在第二块屏幕上会把菜单放到另一块屏幕去。
    #[test]
    fn an_offset_work_area_is_respected() {
        let second_screen: (i32, i32, u32, u32) = (1920, 0, 1920, 1080);
        let (x, y) = position_for((3800, 1000), MENU, second_screen);

        assert!(x >= 1920, "菜单必须留在第二块屏幕上：x={x}");
        assert!(y >= 0, "y={y}");
        assert!(x + MENU.0 as i32 <= 1920 + 1920, "右边缘越界：{}", x + MENU.0 as i32);
    }

    /// 工作区比菜单还小时不能算出负数或越界的位置。
    ///
    /// 这是一种病态输入（正常情况下不会出现），但它必须**有确定的结果**：
    /// 一个 NaN 式的位置会让窗口出现在不可预期的角落里。
    #[test]
    fn a_work_area_smaller_than_the_menu_still_yields_a_defined_position() {
        let tiny: (i32, i32, u32, u32) = (100, 100, 200, 200);
        let (x, y) = position_for((250, 250), MENU, tiny);

        assert_eq!(x, 100, "被钳制到工作区左上角");
        assert_eq!(y, 100);
    }

    /// 结果永远在工作区内 —— 对一批输入做一遍（这是本函数的核心不变式）。
    #[test]
    fn the_result_is_always_inside_the_work_area() {
        let areas: [(i32, i32, u32, u32); 3] = [
            (0, 0, 1920, 1080),
            (1920, 0, 1920, 1080),
            (0, 0, 800, 600),
        ];

        for area in areas {
            let (wx, wy, ww, wh) = (area.0, area.1, area.2 as i32, area.3 as i32);
            for cx in [wx - 50, wx, wx + 1, wx + ww / 2, wx + ww - 1, wx + ww + 50] {
                for cy in [wy - 50, wy, wy + 1, wy + wh / 2, wy + wh - 1, wy + wh + 50] {
                    let (x, y) = position_for((cx, cy), MENU, area);

                    // 工作区比菜单大时，结果必须完全落在里面
                    if ww >= MENU.0 as i32 && wh >= MENU.1 as i32 {
                        assert!(
                            x >= wx && x + MENU.0 as i32 <= wx + ww,
                            "x={x} 超出工作区 {area:?}（光标 {cx},{cy}）"
                        );
                        assert!(
                            y >= wy && y + MENU.1 as i32 <= wy + wh,
                            "y={y} 超出工作区 {area:?}（光标 {cx},{cy}）"
                        );
                    } else {
                        // 工作区装不下时至少不能是负数或垃圾值
                        assert!(x >= wx && y >= wy, "x={x} y={y} 不应小于工作区原点");
                    }
                }
            }
        }
    }

    /// 标签必须与窗口配置一致。
    ///
    /// 这条防的是"改了 label 却忘了改这里"：两处不一致时菜单窗口永远找不到，
    /// 表现为右键托盘没有任何反应（而日志里有一条 warn）。
    #[test]
    fn the_window_label_matches_the_configuration() {
        let conf = include_str!("../../../tauri.conf.json");
        assert!(
            conf.contains(&format!("\"label\": \"{TRAY_MENU_LABEL}\"")),
            "tauri.conf.json 里没有 label 为 {TRAY_MENU_LABEL} 的窗口"
        );
    }
}
