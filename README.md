# Deeplore MLflow 本地变更记录

本文件记录本地对 MLflow 代码, 功能和部署方式的修改.

## 2026-10-04: 分离 Tracking Server 与 Artifact Server

- 变更前: 网络附加存储 (Network Attached Storage, NAS) 上的 `192.168.110.26:5050` 同时提供 MLflow 页面, Tracking API 和 artifacts 上传下载. SQLite 数据库和 artifacts 均保存在 NAS.
- 变更后: Tracking Server, SQLite 数据库及定制前后端迁到本地训练服务器 `192.168.110.148:5050`. NAS `192.168.110.26:5050` 使用官方 MLflow 3.1.4 的 `--artifacts-only` 模式, 继续读写原 artifacts 目录 `/volume1/AI/mlflow/deepdet-yolox`. 本地通过 HTTP 访问独立 Artifact Server.
- 变更原因: 本地开发和部署定制功能更直接, 后续 Benchmark 发布可访问本地数据仓库并执行 Data Version Control (DVC) 和 Git 操作. 大文件继续使用 NAS 存储, artifacts 服务无需随页面和业务代码修改而重新部署.
- 迁移内容: 保留历史 experiment, run 和模型版本的身份, 更新其 artifact 地址引用, 切换 deepdet-yolox 和 deepcls 的客户端地址及共享存储身份. 本地数据库位于 `/data/Projects/mlflow/.local/tracking-server/db/mlflow.db`, 本地 MLflow 数据和管理状态统一保存在 `/data/Projects/mlflow`.
- 兼容性: 使用显式 HTTP artifact 地址, 避免 MLflow 3.1.4 在 SQLite 后端进程中解析 `mlflow-artifacts://` 地址失败.
- 验证结果: 迁移完成. 数据库完整性及历史表记录数量检查通过, 保留 14 个 experiments, 128 个 runs 和 1,396,742 条指标记录. 原生客户端上传, 历史文件下载及两个模型版本描述文件的下载和内容校验通过. 临时验证文件已清理.
- 回退准备: NAS 原 Tracking Server 容器已停止并保留. 本地备份和验证记录位于 `/data/Projects/mlflow/.local/migrations/20261004T084518Z`, NAS 最终数据库备份和原部署配置位于 `/volume1/AI/mlflow/.local/migrations/20261004T084518Z`.

## 2026-10-04: 统一客户端连接配置

- 变更前: 各项目分别维护 `mlflow.env`, 部分工具还依赖其他项目的配置路径.
- 变更后: `/data/Projects/mlflow/.local/mlflow.env` 显式记录 `MLFLOW_TRACKING_URI=http://192.168.110.148:5050` 和 `DEEPLORE_MLFLOW_ARTIFACT_URI=http://192.168.110.26:5050`, 统一由 deeplore-core 的 `load_env_files()` 读取. 进程环境变量优先, 默认文件位置不受工作目录影响; 显式配置文件参数仍可覆盖默认文件位置.
- 地址职责: `DEEPLORE_MLFLOW_ARTIFACT_URI` 是 Deeplore 的服务地址记录, 便于查看. 文件上传下载仍遵循 Tracking Server 返回的 artifact 地址, 不用它重写历史地址. 模型注册继续使用 Tracking Server.
- 项目清理: 删除 deepdet-yolox, deepcls 和 deeplore-deploy 的本地连接文件及 deepcls 的旧配置示例. deepcls, deeplore-deploy 和 deeplore-demo 统一调用 core 加载配置. deepdet-yolox 的上传开关和历史记录频率移入训练配置, 保持上传开启和每 10 个 epoch 记录的默认行为.
- 变更原因: 服务器迁移只需维护一份客户端连接配置, 避免项目间地址漂移和对当前工作目录的依赖.

## 2026-10-06: 简化 Dataset 页面和明确版本记录

- 列表展示: 顶部保留 `Dataset`, `Latest version`, `On disk`. 每个数据集只展示一个最新版本, 优先使用最近一次 MLflow 登记记录的版本; 没有登记记录时兼容显示本地 `metadata.yaml` 的 `version`, 该回退值不代表发布已在 MLflow 完成.
- 元数据展示: 详情默认展开并保持只读, `Metadata` 标题旁通过版本下拉列表切换可读取的元数据. 已登记版本使用对应发布快照, 同版本不混入本地文件的新改动; 尚无对应快照时可查看当前本地元数据. `Source`, `Directory`, `Metrics`, `Hashes`, `Changelog` 随版本一起切换, 其中 `Changelog` 默认折叠. `Release a new version` 表单保持可见, 发布版本选择与元数据浏览互相独立.
- 哈希展示: `Hashes` 始终展开 `train`, `val`, `test` 三行, 显示完整哈希, 缺失值显示 `null`. 已登记版本读取该快照的哈希, 本地元数据读取文件中保存的哈希; 二者都不代表对当前文件实时计算的结果.
- 历史展示: 只有 `Changelog` 说明而没有元数据快照的历史版本不能用于回看元数据. 页面不提供 `Releases` 模块, 版本查询仅用于元数据版本选择.
- 修改流程: 页面禁止直接编辑元数据. 需要调整数据集信息时, 在本地数据仓库的 `data/<dataset>/metadata.yaml` 中修改相应描述或配置, 再在 MLflow 选择下一版本并填写变更说明. 可先使用 `Check` 验证, 再通过 `Release` 确认发布, 将修改纳入新版本的发布快照.
- 发布字段: 不手工伪造 `version` 或 `hashes`. 发布流程执行 DVC 跟踪后生成各数据划分哈希, 自动写入所选版本和哈希, 并向 `changelog` 追加本次变更说明. 随后提交, 创建标签并推送数据和 Git 记录, 最后从标签对应的提交读取元数据并登记到 MLflow. 仅修改本地文件或通过 `Check` 不构成发布完成.
