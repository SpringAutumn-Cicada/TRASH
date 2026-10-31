# AutoDL 信息 JSX 标签修复

分支 ct_dev_test，基线 57b4d1e。开始工作树干净，核对近期提交、实验页历史及依赖目录，未发现仓库 AGENTS.md。

用户启动构建报告 Unexpected closing section tag does not match opening fragment tag。源码确认 AutoDL 信息内 selectedProfile 条件内容以 <> 开始，却误用 </section> 结束；外层信息区另有正确 section 结束标签。修复内层结束标签为 </>，保留外层结构及现有双页签行为。这是此前导航整理引入的语法错误。

实际开发自验仅 Git 状态、历史与源码阅读，未执行 lint、类型检查、测试、构建或浏览器验证，尚未测试，用户验收未执行。用户提供的构建记录为失败，不能据本次源码修复声称构建已通过；待后续授权集中验证或用户重新启动确认。

未合并、未推送、未修改全局配置，未重启或关闭平台。
