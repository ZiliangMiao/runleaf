.. _deeplore-python-api:

deeplore_core
=============

Deeplore 的 MLflow 客户端 API 来自独立的 ``deeplore-core`` 包. 本页按实际 Python 模块列出连接, Run 身份, 共享存储, 评估和模型操作, 使用仓库现有 Sphinx Python API 文档结构. 这些函数不属于官方 ``mlflow`` 命名空间, 需要安装配套客户端.

数据集发布和 Evaluation/Benchmark HTTP 契约见 :ref:`deeplore-rest-api`. 本页以当前配套客户端实现为准.

Data Version Control (DVC) 管理数据内容. Message Digest Algorithm 5 (MD5) 摘要用于内部完整内容识别, 文件为 32 位十六进制, DVC 目录保留 ``.dir``.

.. contents:: 本页内容
   :local:
   :depth: 2

安装和连接
----------

客户端依赖
~~~~~~~~~~

使用与本仓库 API 对应的 ``deeplore-core`` 工作区版本. 当前 ``mlflow`` 可选依赖组固定 ``mlflow==3.1.4``, 并包含 ``python-dotenv>=1.0`` 和 ``loguru>=0.7``.

.. code:: bash

   python -m pip install 'deeplore_core[mlflow]'

导入 Open Neural Network Exchange (ONNX) 模型还需 ``onnx`` 依赖组:

.. code:: bash

   python -m pip install 'deeplore_core[mlflow,onnx]'

官方 MLflow 客户端可调用原生接口, 但官方服务器不包含本文的 ``/api/2.0/deeplore`` 扩展. 数据集发布命令还需能够导入此定制仓库的 ``mlflow.deeplore``, 且执行环境安装 Git 和 DVC.

连接配置
~~~~~~~~

``load_env_files(env_path: Path | None = None) -> None`` 默认读取 ``/data/Projects/mlflow/.local/mlflow.env``, 不再从当前目录向上搜索. 已有进程环境变量优先于文件. 显式指定的文件不存在时抛出 ``FileNotFoundError``; 默认文件不存在时, 只有进程已设置 ``MLFLOW_TRACKING_URI`` 才可继续.

配置示例对应当前仓库部署配置, 使用其他部署时替换服务地址:

.. code-block:: text

   MLFLOW_TRACKING_URI=http://192.168.110.148:5050
   DEEPLORE_MLFLOW_ARTIFACT_URI=http://192.168.110.26:5050

这两个地址均要求 HTTP(S), 第二项可省略. Tracking Server 提供页面, tracking API 和模型注册. Artifact Server 存储产物. ``DEEPLORE_MLFLOW_ARTIFACT_URI`` 仅记录服务地址; 上传下载遵循 Tracking Server 返回的 artifact 地址, 不用它重写远端路径.

.. code:: python

   import mlflow
   from deeplore_core.mlflow_server import load_env_files

   load_env_files()
   print(mlflow.get_tracking_uri())

``MlflowRun`` 不主动加载配置文件. 调用方应在首次查询和创建 run 前加载连接配置. 已设置 tracking 地址时, ``MlflowRun(tracking_uri=...)`` 不会覆盖它; 需要切换时显式调用 ``mlflow.set_tracking_uri(...)``.

共享存储 API
------------

目录和发布约定
~~~~~~~~~~~~~~

所有项目的本地 MLflow 产物, 下载, 模型包及暂存均使用 ``/data/Projects/mlflow``, 通过 ``deeplore_core.mlflow_storage`` 解析路径. 不在消费项目中创建 ``mlruns/``, ``mlartifacts/``, ``.mlflow/`` 或独立 MLflow 输出根目录.

.. code:: text

   /data/Projects/mlflow/
     .local/
       mlflow.env
       metadata.json
       locks/
     experiments/
       <experiment_name>/
         metadata.json
         runs/
           <run_name>/
             .local/
             checkpoints/
             logs/
             outputs/<benchmark>/<timestamp>/
             snapshots/
     models/
       <registered_model_name>/
         .staging/
         <numeric_version>/
           MLmodel
           .local/metadata.json

目录解析可能创建目录, 写入身份记录并访问服务器. ``get_storage_root()`` 检查 tracking/registry 服务身份, 防止同一目录被意外用于另一个服务器. 实现接受 ``DEEPLORE_MLFLOW_ROOT`` 指定 ``/data`` 上的根目录, 本项目统一使用默认 ``/data/Projects/mlflow``.

本地文件写入不等于发布完成. run 产物必须上传到所属 run 的相同相对路径; 模型包必须上传到所属模型. ``.local`` 身份记录, 锁, 下载暂存和同步记录不属于远端产物. 不要上传整个共享根目录或包含 ``.local`` 的 run 目录.

常用客户端路径入口
~~~~~~~~~~~~~~~~~~

来自 ``deeplore_core.mlflow_storage``:

======================================================= ===================================
函数                                                    用途
======================================================= ===================================
``get_run_directory(run_id)``                           打开 run 的共享目录, 校验服务器身份
``get_run_artifact_path(run_id, artifact_path: Path)``  得到与 run artifact 对应的本地路径
``create_evaluation_directory(run_id, benchmark)``      创建独立评估输出目录
``get_model_directory(registered_model_name, version)`` 得到数字模型版本的规范目录
``calculate_file_digest(path: Path)``                   计算完整文件 MD5
======================================================= ===================================

路径解析可能访问服务器并写本地管理状态. 模型缓存通过 ``.local/metadata.json`` 校验身份和每个文件的完整内容, 不只核对文件名或大小.

Run 身份和生命周期
------------------

标签与命名
~~~~~~~~~~

新 run 只使用四个业务标签, 另外保留 ``mlflow.*`` 原生属性. ``normalize_run_tags(tags: Mapping[str, Any]) -> dict[str, Any]`` 会忽略其他自定义标签并告警.

============ ====================================================================== =============================
标签         含义                                                                   示例
============ ====================================================================== =============================
``run_num``  同 project 内递增编号, 从 r1 开始, 不补零                              ``r42``
``base_run`` 训练设置所参考的完整 run name; 无父级使用 ``none``, 多个名称用逗号分隔 ``r41-baseline-none-yolox_m``
``change``   相对参考设置的核心变化, 小写下划线词组                                 ``disable_mixup``
``model``    模型架构和尺寸, 小写下划线词组                                         ``yolox_m``
============ ====================================================================== =============================

当前名称格式是 ``<run_num>-<change>-<base_run_num>-<model_name>``, 例如 ``r42-disable_mixup-r41-yolox_m``. 名称第三段使用父 run 编号, ``base_run`` 标签保存完整名称. ``change`` 和 ``model`` 会转为小写, 非字母数字片段转为下划线.

读取兼容历史 ``run_seq``; 新写入使用 ``run_num``. 同一记录的 ``run_num`` 与 ``run_seq`` 若同时存在且字符串不一致, 会报冲突, 即使是 ``r5`` 与 ``r05`` 也不自动视为一致. ``base_run_id``, ``base_run_num``, 训练版本和测试版本不再作为新 run 的业务标签写入.

Python 接入入口
~~~~~~~~~~~~~~~

``deeplore_core.mlflow_run`` 提供 ``fmt_run_num(n)``, ``next_project_run_num(experiment_name)``, ``compose_run_name(...)``, ``resolve_run(ref, *, project)`` 和 ``resolve_onnx_filename(run_id)``.

编号分配扫描同 project 的 active experiments/runs, 返回最大有效编号加一, 不预留号码. 同项目调用方应串行完成分配和创建. ``resolve_run`` 返回 ``(run_id, run_name, run_num)``, 未找到或身份歧义时报错; project 必须显式传入. 精确名称和编号查询不会在多条匹配时任意选择一条.

``deeplore_core.mlflow_server.MlflowRun`` 负责 start/end, log_params/log_metrics/log_artifact, set_tag/set_tags 和 log_input. 它使用进程级 active run, 不提供多个对象的会话隔离. ``log_artifacts`` 和 ``log_history_per_n_epoch`` 构造参数只保存供训练适配层使用的策略, 不自动执行上传或检查点保存. ``log_params`` 按当前 MLflow 校验常量限制值长度和批量大小, 超长值会被丢弃并告警.

HTTP 接入使用 :doc:`REST API <../rest-api>` 中的原生 Create Experiment, Create Run, Log Batch, Set Tag 和 Log Inputs 等接口. 原生服务器不会替调用方分配 project 编号, 构造 Deeplore run 名称或检查四个业务标签约定.

新建与续训示例
~~~~~~~~~~~~~~

以下示例创建一个新 run. 实际训练前, 应先完成数据集发布文档说明的数据校验, 并在开始训练时记录已验证的 dataset inputs.

.. code:: python

   import mlflow

   from deeplore_core.mlflow_run import (
       compose_run_name,
       fmt_run_num,
       next_project_run_num,
   )
   from deeplore_core.mlflow_server import MlflowRun, load_env_files

   load_env_files()
   experiment_name = "deepdet-baseline"
   run_number = fmt_run_num(next_project_run_num(experiment_name))
   run_name = compose_run_name(
       run_num=run_number,
       model_name="yolox_m",
       base_run_num=None,
       change="baseline",
   )
   run = MlflowRun(
       experiment_name=experiment_name,
       tags={
           "run_num": run_number,
           "base_run": "none",
           "change": "baseline",
           "model": "yolox_m",
       },
   )
   run.start(run_name)
   try:
       run.log_params({"learning_rate": 0.01, "batch_size": 16})
       run.log_metrics({"train/loss": 0.2, "val/accuracy": 0.8}, step=100)
       run_id = run.run_id
   except BaseException:
       mlflow.end_run(status="FAILED")
       raise
   else:
       run.end()

训练异常时, 训练适配层应使用原生 ``mlflow.end_run(status="FAILED")`` 标明失败, 不要把异常运行当作正常完成. ``MlflowRun.end()`` 本身没有 status 参数.

续训先用 ``resolve_run("r42", project="deepdet")`` 取得准确 run_id, 再调用 ``MlflowRun(run_id=run_id).start(None)``. 设置变化时创建新 run, 并把父 run 的完整名称写到 ``base_run``, 父编号传给 ``compose_run_name(base_run_num=...)``.

训练数据接入
------------

业务要求训练前校验所用 train/val 内容与发布身份一致, 评估前校验 test 内容及其 ``_reference.json`` 引用. 目前本文列出的客户端封装和服务端 run 创建入口没有自动执行这套全量检查. 调用方必须在创建 run 或计算评估前完成校验, 运行期间保持输入不变.

``deeplore_core.mlflow_ops.build_dataset_inputs(data_dir, md5s: dict) -> list`` 只构建原生 dataset input 实体. ``md5s`` 是名称到已验证完整 MD5 的映射, 实体名称为 ``<data_dir.parent.name>/<name>``, digest 不截断, 可以保留 ``.dir``. 它不重新计算目录内容, 不查询发布表, 不自动调用 ``log_input``.

调用方对返回的每个实体调用 ``run.log_input(dataset, context="training", tags={"version": version})``; 验证集可使用明确的 validation context. 原生 inputs 与定制 dataset 发布表是两个接口, 名称映射由调用方保持一致. 评估数据身份通过 Evaluation 请求记录, 不写到 run 的四个业务标签中.

旧布局辅助函数 ``deeplore_core.dvc.read_dataset_meta(dvc_file: Path, yaml_file: Path)`` 读取 ``.dvc`` 与旁置 ``.yaml`` 并返回 name/version/md5/metrics. 它不是新布局 ``metadata.yaml + samples/<split>.dvc`` 的全量发布校验器.

Evaluation 客户端
-----------------

写入接口
~~~~~~~~

来自 ``deeplore_core.mlflow_ops``:

.. code:: text

   log_benchmark_evaluation(
       run_id: str,
       *,
       dataset_name: str,
       dataset_version: str,
       test_hash: str,
       checkpoint: Path,
       ckpt_path: Path,
       evaluated_at: int,
       metrics: dict[str, float],
       params: dict[str, str | int | float | bool | None],
       ckpt_hash: str | None = None,
   ) -> dict[str, Any]

``checkpoint`` 是实际用于推理的本地文件, ``ckpt_path`` 是所属 run 的远端相对路径. 函数计算本地 MD5, 若传入加载模型时记录的 ckpt_hash, 先检查文件未变化; 然后独立下载远端文件并比较完整内容摘要, 一致后才提交 Evaluation. 校验暂存位于共享 run 的 ``.local/evaluation-verification/``, 用后清理. 返回 Evaluation 对象, 不包含外层 created/action.

调用要求 HTTP(S) tracking server. ``params`` 在这个 Python 函数中必须显式传入, 即使是空字典. 它验证检查点内容, 不负责重新计算 test 集摘要, 不自动上传评估报告.

归档评估报告示例
~~~~~~~~~~~~~~~~

以下函数接收已完成计算的指标和已验证数据身份. ``checkpoint_hash_at_load`` 必须在加载权重时计算并保存, 不能事后用新文件内容冒充.

.. code:: python

   import json
   from datetime import datetime, timezone
   from pathlib import Path
   from typing import Any

   from deeplore_core.mlflow_ops import log_benchmark_evaluation, upload_run_outputs
   from deeplore_core.mlflow_storage import (
       create_evaluation_directory,
       get_run_directory,
       inherit_permissions,
   )


   # ===== Evaluation publication =====

   def publish_evaluation(
       run_id: str,
       dataset_name: str,
       dataset_version: str,
       test_hash: str,
       checkpoint: Path,
       checkpoint_hash_at_load: str,
       metrics: dict[str, float],
       parameters: dict[str, str | int | float | bool | None],
   ) -> dict[str, Any]:
       """Publish a report and a verified checkpoint evaluation.

       Args:
           run_id: Run owning the checkpoint and report.
           dataset_name: Exact registered dataset name.
           dataset_version: Evaluated dataset version.
           test_hash: Verified test content digest.
           checkpoint: Local weights used for evaluation.
           checkpoint_hash_at_load: Digest captured when loading the weights.
           metrics: Computed finite evaluation metrics.
           parameters: Flat evaluation parameters.

       Returns:
           Evaluation stored by the tracking server.
       """
       evaluated_at = int(datetime.now(timezone.utc).timestamp() * 1000)
       directory = create_evaluation_directory(run_id, dataset_name)
       report = directory / "evaluation.json"
       report.write_text(
           json.dumps(
               {
                   "dataset_name": dataset_name,
                   "dataset_version": dataset_version,
                   "test_hash": test_hash,
                   "ckpt_hash": checkpoint_hash_at_load,
                   "evaluated_at": evaluated_at,
                   "metrics": metrics,
                   "params": parameters,
               },
               indent=2,
               allow_nan=False,
           ),
           encoding="utf-8",
       )
       inherit_permissions(report)
       artifact_directory = directory.relative_to(get_run_directory(run_id))
       upload_run_outputs(run_id, directory, artifact_directory.as_posix())

       return log_benchmark_evaluation(
           run_id,
           dataset_name=dataset_name,
           dataset_version=dataset_version,
           test_hash=test_hash,
           checkpoint=checkpoint,
           ckpt_path=Path("checkpoints") / "best_ckpt.pth",
           evaluated_at=evaluated_at,
           metrics=metrics,
           params=parameters,
           ckpt_hash=checkpoint_hash_at_load,
       )

报告上传和 Evaluation 写入不是一个事务. 后一步失败时报告可能已存在, 应修复原因后重试评估写入, 不把报告存在视为 Evaluation 成功.

``upload_run_outputs(run_id: str, local_dir, artifact_dir: str) -> None`` 递归上传非空目录; 目录缺失或为空时抛出 ``ValueError``, 不再静默跳过. 它不自动过滤 ``.local`` 或检查本地与远端相对目录是否对应, 调用方需像示例一样仅上传产物子树.

兼容接口 ``append_benchmark_eval(run_id, bench, metric_scalars, benchmark_version=None, benchmark_md5=None, history_row=None) -> None`` 仍为旧量化模型调用方保留原生 ``benchmarks-<bench>/`` metrics 和 ``eval_history/<bench>.json`` 表上传. 它不写定制 Evaluation, 不再把版本/hash 写入 run tags, 也不会让结果自动出现在新的 Benchmark 页面. 新的训练检查点评估使用 ``log_benchmark_evaluation``.

Run 血缘
--------

Experiment 的 ``Lineage`` 页面按 base_run 配置参考关系展示血缘, 可选择多个 experiments. 父名称在子 run 所属 project 的 active runs 中解析; 页面将同名歧义和缺失父项显示为外部节点, 分别标记 ambiguous 和 missing. Python ``build_run_lineage`` 对同名歧义抛出 ValueError. 当前没有独立的 lineage HTTP API.

Python 接口来自 ``deeplore_core.mlflow_run``:

.. code:: text

   build_run_lineage(
       experiment_names: str | Sequence[str] | None = None,
       experiment_ids: str | Sequence[str] | None = None,
       metric_key: str = "val/best_ap",
   ) -> dict

   render_run_lineage_mermaid(lineage: dict) -> str

names 与 ids 合并去重, 均未传时使用 ``MLFLOW_EXPERIMENT_NAME``. 返回 ``{"experiments": [...], "nodes": [...], "edges": [...]}``. 每个真实节点包含 run_id/run_name/run_num/experiment/base_run/change/status/best_metric/dataset_version/is_external, 并在解析时派生 base_run_id/base_run_num. 边为 ``(parent_id, child_id, change)``. 派生字段不是新业务 tags.

``dataset_version`` 来自 training context 的原生 inputs. ``render_run_lineage_mermaid`` 将结果转换为 Mermaid 有向图文本, 用于调用方自己的展示或导出.

Model Monitor 和 System Monitor
-------------------------------

下表的 AP 表示平均精度 (Average Precision).

两个 Monitor 均读取原生 MLflow run metrics, 使用 ``MlflowRun.log_metrics``, ``mlflow.log_metric`` 或原生批量日志接口写入. 没有额外的 Monitor HTTP API. 记录 step 的含义由训练调用方统一, 不把 epoch 和优化步骤混为同一尺度.

===================== ===================================================== ====================================
页面图表              建议指标键                                            横轴和单位
===================== ===================================================== ====================================
Model Monitor / train ``train/loss``, ``train/learning_rate``               step, 原始标量
Model Monitor / val   ``val/AP``, ``best_ckpt/AP``, ``early_stop/patience`` step, 原始标量
System Monitor / gpu  ``gpu_0_util``, ``gpu_0_mem``, ``gpu_0_power``        时间; 分别为百分比, mebibytes, watts
System Monitor / cpu  ``cpu_util``                                          时间, 百分比
System Monitor / mem  ``mem``                                               时间, 百分比
===================== ===================================================== ====================================

页面保留记录值及单位, 不自动换算. 也兼容原生 ``system/`` 硬件指标. 采集方只应提交该 run 使用的 GPU 指标; 简短 ``gpu_*`` 名称视为已确认设备归属. ``benchmark``, ``test``, ``eval``, ``evaluation`` 等评估命名空间从 Monitor 排除.

历史步数维护函数 ``mlflow.deeplore.monitor_history.rewrite_monitor_steps(store, plans, dry_run=True)`` 仅用于有完整历史快照和明确映射的管理员修复, 不是日常训练接入接口. 它默认预览, 要求终止状态 run, 校验 expected_history 与现存数据完全匹配, 并拒绝冲突映射.

模型注册和下载
--------------

模型包, 版本与来源
~~~~~~~~~~~~~~~~~~

统一资源标识符 (Uniform Resource Identifier, URI) 用来定位产物和模型. ``runs:/<run_id>/<artifact_path>`` 指向 run 产物; ``models:/<registered_name>/<numeric_version>`` 指向确切数字模型版本. 数字版本不要求与上游模型版本号一致, 血缘通过 ``lineage_source`` 关联.

按交付格式组织容器, 例如 ``deepdet-onnx`` 和 ``deepdet-ambapb``. PyTorch 最佳检查点继续保留为 run artifact. ``ModelVersion.source`` 是可加载的模型包来源, ``lineage_source`` 是上游输入, 两者含义不同.

来源明确的 ONNX 文件统一使用 ``<project>-<run_num>.onnx``, 如 ``deepdet-r42.onnx``. project 从源 run 的 experiment 解析, 编号取源 run 身份, 不从父 run 或仓库目录推测. 变体通过目录区分. ``resolve_onnx_filename`` 兼容旧 run_seq 身份读取.

Model Version API
~~~~~~~~~~~~~~~~~

以下函数来自 ``deeplore_core.mlflow_ops``:

+--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------+------------------------------------------------------------------------+
| 签名                                                                                                                                                                           | 行为                                                                   |
+================================================================================================================================================================================+========================================================================+
| ``register_model_version(registered_model_name, model_source, source_run_id=None, tags=None, lineage_source=None) -> tuple[str, ModelVersion]``                                | 从已存在的包来源创建版本, 返回确切数字 URI 和 ModelVersion. 不负责上传 |
+--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------+------------------------------------------------------------------------+
| ``import_onnx_model_version(registered_model_name, onnx_path: Path, experiment_id=None, source_run_id=None, lineage_source=None, signature=None) -> tuple[str, ModelVersion]`` | 把本地 ONNX 包装, 上传为 Logged Model 并注册数字版本                   |
+--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------+------------------------------------------------------------------------+
| ``fetch_model_version(model_version_uri: str, destination_path: Path | None = None) -> tuple[Path, ModelVersion]``                                                             | 校验后复用或下载到共享模型目录                                         |
+--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------+------------------------------------------------------------------------+
| ``read_onnx_model_path(model_directory: Path) -> Path``                                                                                                                        | 从 MLmodel 的 ONNX flavor 读取入口, 不通过猜文件名寻找模型             |
+--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------+------------------------------------------------------------------------+

``register_model_version`` 要求 source 已存在. lineage_source 只接受已存在的 run 文件 URI 或确切数字模型版本 URI, 不接受可变 alias/stage. ``tags`` 中不能直接设置保留键 lineage_source, 应使用同名参数. 函数会读取回写结果并校验状态 READY, source, source_run_id 和 tags.

``import_onnx_model_version`` 要求 experiment_id 与 source_run_id 恰好传一项, 且调用时没有 active run. 有源 run 时模型归属其 experiment, 包内 ONNX 使用源 run 文件名, 并更新 MLmodel 的 ONNX 和 Python loader 路径. 函数不自动推断输入输出 signature, 不执行推理, 不添加任务特定字段.

暂存发布进度记录在 ``.local/publication.json``; 使用同一暂存目录和相同输入可恢复已记录阶段, 换一个暂存目录不保证请求幂等. 产物上传和版本创建可能已在异常前发生, 重试前应查看现有发布状态.

当前限制: 提供 source_run_id 但无法解析有效编号时会报错. 没有源 run 时, 当前包装实现使用 MLflow 的默认 ONNX 包内命名, 尚未保证保留原始文件名; 不应为满足命名形式伪造 run 编号.

导入和使用示例
~~~~~~~~~~~~~~

下面把已有源 run 的 ONNX 导出注册为模型版本. ``run_id`` 必须指向真实来源, 上游检查点已经上传. 输入文件使用共享 run 路径, 在导入前也上传到同名 run 相对位置.

.. code:: python

   import mlflow
   from pathlib import Path

   from deeplore_core.mlflow_ops import (
       fetch_model_version,
       import_onnx_model_version,
       read_onnx_model_path,
   )
   from deeplore_core.mlflow_run import resolve_onnx_filename, resolve_run
   from deeplore_core.mlflow_server import load_env_files
   from deeplore_core.mlflow_storage import get_run_artifact_path

   load_env_files()
   run_id, _, _ = resolve_run("r42", project="deepdet")
   artifact_directory = Path("outputs") / "onnx"
   onnx_filename = resolve_onnx_filename(run_id)
   onnx_path = get_run_artifact_path(run_id, artifact_directory / onnx_filename)
   if not onnx_path.is_file():
       raise FileNotFoundError(onnx_path)

   client = mlflow.tracking.MlflowClient()
   client.log_artifact(run_id, str(onnx_path), artifact_directory.as_posix())
   version_uri, model_version = import_onnx_model_version(
       registered_model_name="deepdet-onnx",
       onnx_path=onnx_path,
       source_run_id=run_id,
       lineage_source=f"runs:/{run_id}/checkpoints/best_ckpt.pth",
   )
   model_directory, _ = fetch_model_version(version_uri)
   model_path = read_onnx_model_path(model_directory)

示例中的 URI 是远端 API 标识符; 本地路径始终使用 Path. 原始输入文件已经上传到 run, 模型包由 import 函数上传. 本地完整性清单在 ``.local`` 中, 不作为模型 artifact 上传.

CLI ``python -m deeplore_core.mlflow_ops import-onnx-model-version`` 提供 ``--registered-model-name``, ``--onnx-path``, ``--experiment-id`` 或 ``--experiment-name``. 这个入口仅支持无源 run 的导入, 不提供 source_run_id/lineage_source/signature 参数; 有来源的导出使用 Python 接口. experiment name 未指定时可用 ``MLFLOW_EXPERIMENT_NAME``, 按 name 导入时可创建不存在的 experiment.

下载检查点和快照
~~~~~~~~~~~~~~~~

+------------------------------------------------------------------------------------------------------------------------------------------------------------------------------+----------------------------------------------------------------------------------+
| 签名                                                                                                                                                                         | 行为                                                                             |
+==============================================================================================================================================================================+==================================================================================+
| ``fetch_run_artifact(run_id, artifact_path: Path, destination_path: Path | None = None, *, refresh=False) -> Path``                                                          | 下载单文件到共享 run 对应相对路径                                                |
+------------------------------------------------------------------------------------------------------------------------------------------------------------------------------+----------------------------------------------------------------------------------+
| ``fetch_checkpoint(run_id, ckpt_stem, dst_dir: Path | None = None, overwrite=False, ckpt_dir="checkpoints", hist_dir="checkpoints/history", hist_subdir="history") -> Path`` | 自动添加 ``.pth``; epoch\_ 前缀使用 history 目录, overwrite 控制重新下载         |
+------------------------------------------------------------------------------------------------------------------------------------------------------------------------------+----------------------------------------------------------------------------------+
| ``fetch_snapshot(run_id, run_name, dst_dir: Path | None = None, overwrite=False, snapshot_dir="snapshots") -> Path``                                                         | 下载配置 ``.py`` 及存在的同名 ``.json``, 返回 ``.py`` 路径; 可匹配唯一历史配置对 |
+------------------------------------------------------------------------------------------------------------------------------------------------------------------------------+----------------------------------------------------------------------------------+

destination_path/dst_dir 仅用于断言规范共享位置, 不是另选输出目录. ``.pt`` 文件应使用 ``fetch_run_artifact``. ``overwrite=False`` 通常复用已有文件, 不再按旧文档描述为必然抛出 FileExistsError.

下载记录包含内容 MD5. 对未结束 run 的下载缓存会重新获取; ``refresh=True`` 明确刷新可变的 best/latest 文件. 当前实现也会复用本地产出的非空文件或未带下载清单的文件, 因此本地存在不能证明远端一致; 发布 Evaluation 时仍需独立远端内容校验.

``fetch_model_version`` 只接受确切数字 URI, 不接受 alias/stage. 完整缓存按身份和文件内容校验后复用; 目标目录已存在但不完整时抛出 FileExistsError, 需要先修复, 不自动覆盖整个包.

与旧文档和设计约定的差异
------------------------

+---------------------------------------------------------------------------------+-------------------------------------------------------------------------------+
| 旧描述或设计设想                                                                | 当前使用方式                                                                  |
+=================================================================================+===============================================================================+
| run_seq 使用 r05, 名称为编号-模型-父编号-change                                 | 新写入 run_num=r5, 名称为编号-change-父编号-模型; 保留旧读取兼容              |
+---------------------------------------------------------------------------------+-------------------------------------------------------------------------------+
| base_run_id 是持久化血缘真源                                                    | 使用 base_run 完整名称, id/父编号在查询时派生                                 |
+---------------------------------------------------------------------------------+-------------------------------------------------------------------------------+
| Dataset input 摘要取前 8 位                                                     | 使用完整 MD5, DVC 目录保留 ``.dir``                                           |
+---------------------------------------------------------------------------------+-------------------------------------------------------------------------------+
| 向上搜索项目 mlflow.env                                                         | 默认固定读取共享 ``.local/mlflow.env``                                        |
+---------------------------------------------------------------------------------+-------------------------------------------------------------------------------+
| benchmark metrics 和历史表就是正式评估                                          | 新写入独立 Evaluation; 旧接口仅保留兼容                                       |
+---------------------------------------------------------------------------------+-------------------------------------------------------------------------------+
| ``dataset_hash``, ``checkpoint_path``, ``checkpoint_hash``, ``evaluation_time`` | HTTP 字段为 ``test_hash``, ``ckpt_path``, ``ckpt_hash``, ``evaluated_at``     |
+---------------------------------------------------------------------------------+-------------------------------------------------------------------------------+
| 任意模型文件可写 Evaluation                                                     | 当前入口限定 best_ckpt.pth/best.pt                                            |
+---------------------------------------------------------------------------------+-------------------------------------------------------------------------------+
| 页面创建/删除数据集, 发布前失败完整回滚, 有 Retry 按钮                          | 未提供创建/删除/Retry 入口; 失败恢复按数据集发布文档的实际阶段处理            |
+---------------------------------------------------------------------------------+-------------------------------------------------------------------------------+
| run 启动自动验证 train/val                                                      | 当前公共封装不自动做全量数据校验, 调用方负责                                  |
+---------------------------------------------------------------------------------+-------------------------------------------------------------------------------+
| Benchmark 尚未实现                                                              | 已有查询 API 和 Table/Chart 比较页面                                          |
+---------------------------------------------------------------------------------+-------------------------------------------------------------------------------+
| ``register_checkpoint`` 注册裸检查点指针                                        | 该函数已移除, 使用模型包注册/导入接口                                         |
+---------------------------------------------------------------------------------+-------------------------------------------------------------------------------+
| Model Registry 暂不处理                                                         | 客户端已有数字版本, ONNX 导入, 精确来源和下载 API; 不等于固件打包流程已经完成 |
+---------------------------------------------------------------------------------+-------------------------------------------------------------------------------+
| validation 版本变化后自动重选最佳检查点并重评估                                 | 尚未提供自动重选与重跑流程                                                    |
+---------------------------------------------------------------------------------+-------------------------------------------------------------------------------+


deeplore_core.mlflow_server
---------------------------

.. py:module:: deeplore_core.mlflow_server

连接配置, run 生命周期及服务器查询接口. 除显式接收 ``client`` 的函数外, 查询使用进程当前 Tracking Server 配置. 网络和服务器错误由 MLflow 原样传播. ``MlflowRun`` 使用进程级 active run, 多个实例不提供会话隔离.

.. py:data:: MLFLOW_ENV_FILENAME
   :type: str
   :value: "mlflow.env"

   默认连接配置文件名.

.. py:data:: MLFLOW_ENV_PATH
   :type: pathlib.Path

   默认路径为 ``/data/Projects/mlflow/.local/mlflow.env``.

.. py:function:: load_env_files(env_path: Path | None = None) -> None

   加载固定共享配置, 已有进程环境变量优先. 不从当前目录向上搜索. 上传下载仍遵循 Tracking Server 返回的产物地址, ``DEEPLORE_MLFLOW_ARTIFACT_URI`` 仅保存配置值.

   :param env_path: 显式配置文件路径, 为 None 时使用 MLFLOW_ENV_PATH.
   :returns: None. 将文件中尚未设置的变量加载到进程环境.
   :raises FileNotFoundError: 显式文件不存在, 或默认文件不存在且进程未设置 MLFLOW_TRACKING_URI.
   :raises ValueError: MLFLOW_TRACKING_URI 或已提供的 DEEPLORE_MLFLOW_ARTIFACT_URI 不是含主机的 HTTP(S) 地址.

.. py:function:: normalize_run_tags(tags: Mapping[str, Any]) -> dict[str, Any]

   保留 ``run_num``, ``base_run``, ``change``, ``model`` 和 ``mlflow.*`` 标签. 其他标签被忽略并告警. 编号去除补零, change/model 转小写, 非字母数字片段变为下划线. 不解析 base_run 指向的 run.

   :param tags: 待写入的业务标签及 MLflow 原生属性映射.
   :returns: 规范化后的新映射, 不修改输入映射.
   :raises ValueError: run_num 不是正整数的 r 前缀编号, 或 change/model 规范化后为空.

.. py:class:: MlflowRun(*, tracking_uri: Optional[str] = None, experiment_name: Optional[str] = None, log_artifacts: bool = False, log_history_per_n_epoch: int = 0, flatten_params: bool = False, run_id: Optional[str] = None, tags: Optional[dict] = None)

   保存显式训练配置, 在调用 start 后操作进程级 active run. 构造函数不建立 run, 不加载连接文件, 也不自动上传文件或保存检查点.

   :param tracking_uri: start 时采用的 Tracking Server 地址. 仅在 MLflow 尚未设置 tracking 地址时生效.
   :param experiment_name: start 的默认 experiment 名称. 若提供且不存在, start 调用 MLflow 创建它.
   :param log_artifacts: 保存给训练适配层使用的上传策略标志. 不限制显式 log_artifact 调用.
   :param log_history_per_n_epoch: 保存给训练适配层使用的历史检查点周期. 此类不执行周期保存.
   :param flatten_params: 是否在 log_params 中把非空嵌套映射展开为点分隔名称.
   :param run_id: start 时重连的默认 run 标识符. None 表示未显式指定重连目标.
   :param tags: start 完成后通过 set_tags 规范化并写入的标签.

   .. py:attribute:: log_artifacts
      :type: bool

      可读写的上传策略标志, 初值来自构造参数. 此类仅保存值.

   .. py:attribute:: log_history_per_n_epoch
      :type: int

      可读写的历史检查点保存周期, 初值来自构造参数. 此类仅保存值.

   .. py:method:: start(run_name: Optional[str], experiment_name: Optional[str] = None, run_id: Optional[str] = None) -> MlflowRun

      建立或重连 run, 解析其共享目录, 在本地管理记录写入 ``local_producer=True``, 然后写入构造参数中的 tags. 实际目录和管理状态位于共享 MLflow 存储. 共享目录初始化失败时以 FAILED 结束刚打开的 run 并传播异常.

      :param run_name: 新 run 的名称, 重连时由 MLflow 忽略. 即使为 None 也需显式传入.
      :param experiment_name: 本次 experiment 名称, 非空时覆盖构造参数.
      :param run_id: 本次重连标识符, 非空时覆盖构造参数. 两处均为空时仍受原生 MLflow 的环境配置影响.
      :returns: 当前实例, 可用于链式调用.
      :raises ValueError: 共享存储身份或标签不符合约定等验证失败.
      :raises OSError: 共享目录或本地管理记录无法读写.
      :raises mlflow.exceptions.MlflowException: 服务器操作失败, 或当前 active run 与启动请求不兼容.

   .. py:method:: end() -> None

      若进程存在 active run, 调用原生 end_run 结束它. 没有 active run 时不操作. 不接受 status 参数; 标记训练失败应直接调用 ``mlflow.end_run(status="FAILED")``.

      :returns: None.
      :raises mlflow.exceptions.MlflowException: 结束 run 的服务器操作失败.

   .. py:property:: reattached
      :type: bool

      :returns: 最近一次 start 是否显式选择了方法或构造参数中的 run_id. 不通过查询服务器推断重连状态, 初值为 False.

   .. py:property:: active
      :type: bool

      :returns: 进程当前是否存在 active run, 不限定该 run 是否由此实例创建.

   .. py:property:: run_id
      :type: Optional[str]

      :returns: 当前 active run 的标识符, 无 active run 时为 None.

   .. py:property:: experiment_id
      :type: Optional[str]

      :returns: 当前 active run 的 experiment 标识符, 无 active run 时为 None.

   .. py:property:: active_run_name
      :type: Optional[str]

      :returns: 当前 active run 的名称, 无 active run 时为 None.

   .. py:property:: tracking_uri
      :type: str

      :returns: 进程当前实际使用的 tracking 地址, 不保证等于构造参数.

   .. py:method:: log_params(params: dict) -> None

      根据 flatten_params 展开参数. 采用当前安装的 MLflow 校验常量限制值长度与批量大小, 超长值被忽略并告警. 不修改调用方字典.

      :param params: 待记录超参数映射, 值由 MLflow 转成字符串. 非空嵌套映射仅在 flatten_params=True 时展开.
      :returns: None.
      :raises mlflow.exceptions.MlflowException: 参数格式无效, 已记录参数值冲突, 或服务器写入失败.

   .. py:method:: log_metrics(metrics: dict, step: int) -> None

      将指标传给原生 MLflow. 调用方先将张量转换成普通数值.

      :param metrics: 指标名到数值的映射.
      :param step: 本次指标记录的步骤编号.
      :returns: None.
      :raises mlflow.exceptions.MlflowException: 指标校验或服务器写入失败.

   .. py:method:: log_artifact(path: Union[str, Path], artifact_dir: str) -> bool

      上传单个已有文件. 不递归上传目录, 不受 log_artifacts 策略属性控制. 新代码应以 Path 提供本地路径, 并维持共享本地路径与所属 run 产物相对路径一致.

      :param path: 本地文件路径. 当前签名兼容字符串, 推荐 Path.
      :param artifact_dir: 目标 run 产物目录的相对路径.
      :returns: 上传成功为 True. 路径不存在或不是普通文件时告警并返回 False.
      :raises mlflow.exceptions.MlflowException: 产物服务器拒绝上传或其他 MLflow 上传错误.
      :raises OSError: 本地文件读取失败.

   .. py:method:: set_tag(key: str, value: Any) -> None

      通过 set_tags 写入单个标签, 遵循相同的业务标签白名单.

      :param key: 标签名.
      :param value: 标签值, 规范化后由 MLflow 记录.
      :returns: None. 不支持的标签被忽略并告警.
      :raises ValueError: run_num 或 change/model 标签值无效.
      :raises mlflow.exceptions.MlflowException: 标签写入失败.

   .. py:method:: set_tags(tags: dict) -> None

      先调用 normalize_run_tags, 结果非空时才写入服务器.

      :param tags: 标签名到值的映射.
      :returns: None.
      :raises ValueError: run_num 或 change/model 标签值无效.
      :raises mlflow.exceptions.MlflowException: 标签写入失败.

   .. py:method:: log_input(dataset: Any, context: str, tags: dict) -> None

      记录原生 MLflow dataset input. 此函数不计算数据摘要, 不验证工作区内容, 不发布定制 Dataset version.

      :param dataset: 原生 mlflow.data 数据集实体.
      :param context: 数据用途, 例如 training 或 validation.
      :param tags: 本次 input 的附加标签, 例如已验证的 version. 不应用 run 标签白名单.
      :returns: None.
      :raises mlflow.exceptions.MlflowException: input 校验或服务器写入失败.

.. py:function:: resolve_run_num_tag(tags: Mapping[str, str], *, base: bool = False) -> str | None

   读取当前编号标签, 缺失时兼容旧标签. 同时存在时按字符串严格比较, ``r5`` 和 ``r05`` 视为不同值. 本函数不校验或格式化编号内容.

   :param tags: run 标签映射.
   :param base: False 读取 run_num/run_seq; True 读取 base_run_num/base_run_seq.
   :returns: 当前标签值, 否则旧标签值; 两者均缺失时为 None.
   :raises ValueError: 当前与旧标签同时存在且值不同.

.. py:function:: search_experiment_runs(client: MlflowClient, experiment_id: str) -> list

   自动读取全部分页, 使用 MLflow 默认的 active 生命周期筛选. active 指未删除, 不要求训练仍在运行.

   :param client: 已配置的 MLflow tracking 客户端.
   :param experiment_id: 待查询的 experiment 标识符.
   :returns: 该 experiment 的 mlflow.entities.Run 对象列表.
   :raises mlflow.exceptions.MlflowException: 查询失败.

.. py:function:: project_from_experiment_name(experiment_name: str) -> str

   以首个连字符分隔 project 与后缀.

   :param experiment_name: 形如 deepdet-baseline 的名称.
   :returns: 首个连字符之前的 project 字段.
   :raises ValueError: project 为空或含空白, 没有连字符, 或后缀仅含空白.

.. py:function:: search_project_experiments(client: MlflowClient, project: str) -> list[mlflow.entities.Experiment]

   自动读取全部分页, 只保留 active experiments 中首字段精确等于 project 且后缀非空的条目. 不从环境或 active experiment 猜测 project.

   :param client: 已配置的 MLflow tracking 客户端.
   :param project: 显式 project 名称, 不能含空白或连字符.
   :returns: 匹配的 experiment 对象列表.
   :raises ValueError: project 为空或含空白/连字符.
   :raises mlflow.exceptions.MlflowException: 查询失败.

.. py:function:: search_run(filter_string: str, *, project: str) -> Optional[mlflow.entities.Run]

   在指定 project 的 active experiments 中使用原生筛选表达式查询. 多条匹配时告警并返回 start_time 最新一条; 此策略不同于下方身份查询的歧义报错.

   :param filter_string: 原生 MLflow search_runs 筛选表达式.
   :param project: 显式 project 字段.
   :returns: 最新匹配 run 对象, 无匹配时为 None.
   :raises ValueError: project 格式无效.
   :raises mlflow.exceptions.MlflowException: 筛选表达式无效或查询失败.

.. py:function:: search_run_by_name(run_name: str, *, project: str) -> Optional[str]

   在指定 project 的 active experiments/runs 中匹配完整名称, 不任意选择重复名称中的一条.

   :param run_name: 需要精确匹配的当前或历史完整 run name.
   :param project: 显式 project 字段.
   :returns: 唯一匹配的 run_id, 无匹配时为 None.
   :raises ValueError: project 格式无效, 或同项目存在多个匹配名称.
   :raises mlflow.exceptions.MlflowException: 查询失败.

.. py:function:: search_run_by_run_num(run_num: str, *, project: str) -> Optional[tuple[str, str]]

   按 run_num 标签查询, 兼容旧 run_seq. 匹配时接受补零差异, 例如 r5/r05; 但单个 run 同时存在冲突新旧标签仍报错.

   :param run_num: 正整数的 r 前缀编号.
   :param project: 显式 project 字段.
   :returns: 唯一匹配的 ``(run_id, run_name)``, 无匹配时为 None. 名称保留服务器原值.
   :raises ValueError: project 或编号无效, 编号匹配多条 run, 或被扫描 run 的新旧编号标签冲突.
   :raises mlflow.exceptions.MlflowException: 查询失败.

.. py:function:: resolve_experiment(client: MlflowClient, experiment_name: Optional[str] = None, experiment_id: Optional[str] = None) -> mlflow.entities.Experiment

   只解析已有 experiment, 不创建. 优先使用非空 experiment_id, 再使用名称, 最后回退到 MLFLOW_EXPERIMENT_NAME.

   :param client: 已配置的 MLflow tracking 客户端.
   :param experiment_name: 待查名称, 无显式 id 时使用.
   :param experiment_id: 待查标识符, 非空时优先于名称.
   :returns: 已存在的 experiment 对象.
   :raises ValueError: 未指定可用名称/id, 或客户端返回未找到.
   :raises mlflow.exceptions.MlflowException: 客户端按 id 查询不存在对象或其他服务器查询失败.

兼容入口 ``search_run_by_run_seq(run_seq: str, *, project: str) -> Optional[tuple[str, str]]`` 直接调用 search_run_by_run_num. run_seq 为旧参数名, project 仍必须显式提供; 返回值与异常行为相同.


deeplore_core.mlflow_run
------------------------

.. py:module:: deeplore_core.mlflow_run

project 内 run 身份, 名称和血缘关系. 查询使用进程当前 Tracking Server, 不通过项目本地文件猜测 run 身份. 下列查询函数的网络及服务器错误由 MLflow 原样传播.

.. py:function:: fmt_run_num(n: int) -> str

   格式化 project 内编号, 不补零且不限制总位数.

   :param n: 大于零的 Python 整数, 不接受 bool.
   :returns: 例如 r1 或 r123.
   :raises ValueError: n 不是正整数.

.. py:function:: next_project_run_num(experiment_name: str) -> int

   从 experiment 名称解析 project, 扫描其 active experiments/runs 的有效编号标签并取最大值加一. 目标 experiment 无需已经存在. 不预留号码, 同项目的分配和创建需要调用方串行执行.

   :param experiment_name: 形如 deepdet-baseline 的目标 experiment 名称.
   :returns: 下一整数编号, 没有有效历史编号时为 1. 使用 fmt_run_num 转换为标签.
   :raises ValueError: experiment 名称无效, 或被扫描 run 的新旧编号标签冲突.
   :raises mlflow.exceptions.MlflowException: 查询失败.

.. py:function:: next_global_run_num(experiment_name: str) -> int

   兼容旧入口, 现在等价于 next_project_run_num, 不提供跨 project 的全局编号分配.

   :param experiment_name: 必填目标 experiment 名称, 形如 deepdet-baseline.
   :returns: 该 project 的下一整数编号.
   :raises ValueError: experiment 名称无效或编号标签冲突.
   :raises mlflow.exceptions.MlflowException: 查询失败.

.. py:function:: compose_run_name(run_num: Optional[str] = None, model_name: Optional[str] = None, base_run_num: Optional[str] = None, change: Optional[str] = None, *, run_seq: Optional[str] = None, base_run_seq: Optional[str] = None) -> str

   构造 ``<run_num>-<change>-<base_run_num>-<model_name>``. run 编号去补零, model/change 转小写并用下划线替换非字母数字片段. 多父编号以逗号输入, 在名称中以下划线连接. 不创建 run, 不验证父 run 存在.

   :param run_num: 本 run 的正整数 r 前缀编号. 未提供时名称使用 rNA.
   :param model_name: 模型名称, 规范化后为空时使用 model.
   :param base_run_num: 逗号分隔的父 run 编号; None, 空字符串或 none 表示无父级.
   :param change: 变更词组, 规范化后为空时使用 na.
   :param run_seq: run_num 的旧关键字名. 新旧参数同时提供时必须完全一致.
   :param base_run_seq: base_run_num 的旧关键字名, 同样要求新旧参数一致.
   :returns: 规范化的四字段 run name.
   :raises ValueError: 新旧参数冲突, 或非空 run/父级编号不是正整数 r 前缀编号.

.. py:function:: resolve_run(ref: str, *, project: str) -> tuple[str, str, str]

   按编号或完整名称解析唯一 run. 名称查询失败时尝试验证旧四字段名称与当前标签的对应关系. 编号来自服务器标签, 名称查询且无编号标签时才使用输入名称首字段; 不把该回退视为编号验证.

   :param ref: r42/r042 等编号或完整 run name, 首尾空白会移除. 不把裸 run_id 作为独立查询形式.
   :param project: 显式限定的 project 字段.
   :returns: ``(run_id, run_name, run_num)``. 名称以服务器为准, 已有编号标签保留原字符串.
   :raises ValueError: project/ref 无效, 未找到 run, 身份匹配多条 run, 或新旧编号标签冲突.
   :raises mlflow.exceptions.MlflowException: 查询失败.

.. py:function:: resolve_onnx_filename(run_id: str) -> str

   从源 run 的 experiment 名称解析 project, 从 run_num/旧 run_seq 标签读取编号, 无编号标签时回退到 run name 首字段. Open Neural Network Exchange (ONNX) 文件名仅使用源 run 身份, 不使用父 run 编号或仓库目录名. 现有有效编号字符串不被重新补零或去零.

   :param run_id: 配置服务器上的准确源 run 标识符.
   :returns: 例如 ``deepdet-r42.onnx`` 的文件名, 不含目录.
   :raises ValueError: experiment 命名无效, 编号不符合 r 加数字格式, 新旧编号标签冲突, 或 project 包含路径分隔符/空字符.
   :raises mlflow.exceptions.MlflowException: 源 run 或 experiment 不存在, 或查询失败.

.. py:function:: build_run_lineage(experiment_names: Union[str, Sequence[str], None] = None, experiment_ids: Union[str, Sequence[str], None] = None, metric_key: str = "val/best_ap") -> dict

   合并选定 experiments 的 active runs, 按开始时间排序. base_run 保存的完整父名称在子 run 所属 project 内查询; 未被选入的父 run 或缺失引用显示为外部节点. 派生父编号/id 不回写标签. 此函数不检测环, 不自动启动训练或评估.

   :param experiment_names: 一个名称或名称序列. 与 experiment_ids 取并集并按 experiment_id 去重.
   :param experiment_ids: 一个标识符或标识符序列. 两种筛选均为空时使用 MLFLOW_EXPERIMENT_NAME.
   :param metric_key: 读取到各内部节点 best_metric 的原生指标名.
   :returns: 包含 experiments 名称列表, nodes 列表和 edges 列表的字典. 边为 ``(parent_id, child_id, change)``. 节点包含 run_id/run_name/run_num/experiment/base_run/base_run_id/base_run_num/change/status/best_metric/dataset_version/is_external. dataset_version 来自 training inputs 的 version 或旧 trainval_version 标签.
   :raises ValueError: experiment 未指定或不存在, project 命名无效, 父名称有歧义, 或新旧身份标签冲突.
   :raises mlflow.exceptions.MlflowException: 查询失败.

.. py:function:: render_run_lineage_mermaid(lineage: dict) -> str

   将血缘字典转换为 Mermaid ``flowchart TD`` 源码. 多 experiment 分为子图, 外部节点留在子图外. 根节点与外部节点分别应用样式; 不写文件, 不运行渲染器.

   :param lineage: build_run_lineage 返回的完整字典. nodes/edges 及必需节点字段须保留.
   :returns: Mermaid 文本, 节点显示名称以及可用的指标和数据版本, 边显示子 run 的 change.
   :raises KeyError: 输入缺失必要字段.
   :raises TypeError: 输入结构或指标值不适合当前渲染逻辑.

兼容别名 ``fmt_run_seq`` 指向 fmt_run_num, ``next_project_run_seq`` 指向 next_project_run_num, ``next_global_run_seq`` 指向 next_global_run_num. 参数和返回值与对应函数相同. 新代码使用 run_num 命名.


deeplore_core.mlflow_ops
------------------------

.. py:module:: deeplore_core.mlflow_ops

.. py:function:: build_dataset_inputs(data_dir: str | Path, md5s: dict) -> list

   根据已验证的完整 MD5 构建原生 MLflow dataset input 实体. 不计算工作区内容, 不查询发布表, 不自动调用 log_input.

   :param data_dir: 数据目录, 实体名称为 <data_dir.parent.name>/<name>. 接受字符串或 Path.
   :param md5s: 名称到完整 MD5 的映射, 可保留目录摘要的 .dir 后缀.
   :returns: 原生 dataset 实体列表; 运行环境缺少所需 mlflow.data 类型时返回空列表.
   :raises ValueError: 任一摘要不是完整 MD5 或目录摘要.

.. py:function:: upload_run_outputs(run_id: str, local_dir: str | Path, artifact_dir: str) -> None

   递归上传产物子目录到指定 run. 不过滤 .local, 不验证本地与远端相对目录对应关系, 也不创建 Evaluation.

   :param run_id: 产物所属的现有 run.
   :param local_dir: 存在且非空的本地产物目录, 接受字符串或 Path.
   :param artifact_dir: 远端 run 产物根目录下的相对目录; 调用方应保持与共享 run 中的相对路径一致.
   :returns: None; 上传失败会传播异常.
   :raises ValueError: 本地目录缺失或为空.
   :raises mlflow.exceptions.MlflowException: 远端上传失败.

.. py:function:: log_benchmark_evaluation(run_id: str, *, dataset_name: str, dataset_version: str, test_hash: str, checkpoint: Path, ckpt_path: Path, evaluated_at: int, metrics: dict[str, float], params: dict[str, str | int | float | bool | None], ckpt_hash: str | None=None) -> dict[str, Any]

   先计算本地检查点 MD5, 再独立下载所属 run 的最佳检查点比较内容, 一致后调用定制 Evaluation HTTP API. 校验暂存使用共享 run 的 .local/evaluation-verification 并在结束时清理. 不重算 test 内容, 不上传报告.

   :param run_id: 检查点和评估结果所属 run.
   :param dataset_name: 精确数据集名称.
   :param dataset_version: 评估使用的数据集版本.
   :param test_hash: 已验证的 test 完整 MD5, 目录摘要保留 .dir.
   :param checkpoint: 实际用于推理且非空的本地检查点文件.
   :param ckpt_path: 所属 run 的远端相对路径; basename 仅接受 best_ckpt.pth 或 best.pt, 不允许 .local.
   :param evaluated_at: 评估时间, 非负 Unix 毫秒整数.
   :param metrics: 非空的有限数值指标映射.
   :param params: 必须显式传入的平铺评估参数; 空参数使用 {}.
   :param ckpt_hash: 可选的加载权重时保存的完整文件 MD5; 与当前文件不一致时拒绝发布.
   :returns: 服务器返回的 Evaluation 对象, 不包含外层 created/action.
   :raises ValueError: 检查点缺失或为空, 路径无效, 文件加载后变化, 或远端内容不一致.
   :raises RuntimeError: tracking store 不是可用的 HTTP(S) 连接.
   :raises mlflow.exceptions.MlflowException: 产物下载或 Evaluation 请求失败.

.. py:function:: append_benchmark_eval(run_id: str, bench: str, metric_scalars: dict[str, float], benchmark_version: Optional[str]=None, benchmark_md5: Optional[str]=None, history_row: Optional[dict[str, Any]]=None) -> None

   兼容旧量化模型调用方. 写入原生 benchmarks-<bench>/ 指标, 按需上传 eval_history/<bench>.json. 不创建定制 Evaluation, 不写评估身份业务标签, 结果不会自动进入新的 Benchmark 页面.

   :param run_id: 评估模型所属的现有 run.
   :param bench: 旧指标和表产物使用的 benchmark 名称.
   :param metric_scalars: 转换为 float 后写入的指标.
   :param benchmark_version: 仅为兼容保留, 当前不参与写入.
   :param benchmark_md5: 仅为兼容保留, 当前不参与写入.
   :param history_row: 可选历史表行; 非空时追加到表产物.
   :returns: None.
   :raises mlflow.exceptions.MlflowException: 启动 run 或日志上传失败.

.. py:function:: register_model_version(registered_model_name: str, model_source: str, source_run_id: Optional[str]=None, tags: Optional[dict[str, object]]=None, lineage_source: Optional[str]=None) -> tuple[str, ModelVersion]

   从已经存在的模型包来源创建数字 Model Version, 返回前检查 READY 状态及持久化来源和标签. 不上传模型包. 缺少 Registered Model 时会创建容器.

   :param registered_model_name: 目标 Registered Model 名称.
   :param model_source: 已经存在的可加载模型包来源, 例如 runs:/<run_id>/<package_path>.
   :param source_run_id: 可选的源 run 标识.
   :param tags: 可选模型版本标签, 值转为字符串; 禁止直接写保留键 lineage_source.
   :param lineage_source: 可选且必须存在的上游输入, 仅接受 runs:/<run_id>/<file_path> 或 models:/<name>/<numeric_version>, 不接受 alias/stage.
   :returns: (确切数字模型版本 URI, ModelVersion).
   :raises ValueError: 名称, 来源, 标签或上游引用无效.
   :raises FileNotFoundError: 上游 run 文件不存在.
   :raises RuntimeError: 版本不是 READY, 或回读身份, 来源, 标签不一致.
   :raises mlflow.exceptions.MlflowException: 远端查询或版本创建失败.

.. py:function:: import_onnx_model_version(registered_model_name: str, onnx_path: Path, experiment_id: Optional[str]=None, source_run_id: Optional[str]=None, lineage_source: Optional[str]=None, signature: Optional[ModelSignature]=None) -> tuple[str, ModelVersion]

   把本地 ONNX 文件包装并上传为 Logged Model, 然后创建数字 Model Version. experiment_id 与 source_run_id 恰好传一项, 调用时不能存在 active run. 不推断 signature, 不运行推理. 有来源时按源 run 身份命名包内 ONNX; 无来源时当前实现使用 MLflow 默认包内命名.

   :param registered_model_name: 目标 Registered Model 名称.
   :param onnx_path: 已经存在的本地 ONNX 文件.
   :param experiment_id: 无来源 run 时 Logged Model 所属的现有 experiment, 与 source_run_id 互斥.
   :param source_run_id: 产生模型的源 run; 使用该 run 所属 experiment, 并登记模型版本来源.
   :param lineage_source: 可选的确切上游文件或数字模型版本引用, 发布前验证存在.
   :param signature: 调用方已经验证的可选输入输出签名.
   :returns: (确切数字模型版本 URI, ModelVersion). 发布阶段记录在暂存目录的 .local/publication.json; 更换暂存目录不保证重试幂等.
   :raises FileNotFoundError: 输入 ONNX 或上游文件不存在.
   :raises ImportError: 缺少 ONNX 发布依赖.
   :raises RuntimeError: 存在 active run, 或上传注册状态不一致.
   :raises ValueError: 名称, 归属选择, 源 run 编号或上游引用无效.
   :raises mlflow.exceptions.MlflowException: 远端查询, 上传或版本创建失败.

.. py:function:: fetch_model_version(model_version_uri: str, destination_path: Optional[Path]=None) -> tuple[Path, ModelVersion]

   校验身份和文件内容后复用缓存, 或下载到规范共享模型目录. 仅接受确切数字版本, 不接受 alias/stage. 已存在但不完整的包需要先修复, 不自动覆盖.

   :param model_version_uri: models:/<registered_model_name>/<positive_numeric_version>.
   :param destination_path: 可选的规范目标目录断言, 不能指定独立下载位置.
   :returns: (共享模型包目录 Path, 服务器 ModelVersion).
   :raises ValueError: 版本引用, 目标目录或缓存身份无效.
   :raises FileExistsError: 目标目录已存在但完整性校验未通过.
   :raises RuntimeError: 版本不是 READY 或下载未落在指定目录.
   :raises mlflow.exceptions.MlflowException: 版本查询或下载失败.

.. py:function:: read_onnx_model_path(model_directory: Path) -> Path

   读取 MLmodel 的 ONNX flavor 获取入口文件, 不猜文件名, 不加载权重或初始化推理运行时.

   :param model_directory: 包含 MLmodel 的本地模型包目录.
   :returns: 包内非空原始 ONNX 文件的绝对 Path.
   :raises FileNotFoundError: MLmodel 或所引用 ONNX 文件缺失.
   :raises ValueError: 元数据无效, 缺少 ONNX flavor, 或入口为空, 越界, 类型错误或属于编译文件.

.. py:function:: fetch_run_artifact(run_id: str, artifact_path: Path, destination_path: Optional[Path]=None, *, refresh: bool=False) -> Path

   复用或下载单个 run 文件到规范共享位置. 有下载记录且任一记录状态不是 FINISHED 时重新获取; 本地产出文件或缺少下载记录的非空文件可能直接复用, 因而本地存在不证明远端内容一致.

   :param run_id: 产物所属 run.
   :param artifact_path: 远端产物根目录下的安全相对文件路径.
   :param destination_path: 可选的规范本地目标路径断言, 不允许另选输出位置.
   :param refresh: 为 True 时强制重新下载, 适用于可能变化的 best/latest 文件.
   :returns: 规范共享文件 Path. 下载记录保存完整内容 MD5.
   :raises ValueError: 产物路径, 目标位置或共享身份无效.
   :raises FileExistsError: 目标已存在但不是文件.
   :raises RuntimeError: 下载没有返回指定暂存目录中的文件.
   :raises mlflow.exceptions.MlflowException: run 查询或下载失败.

.. py:function:: fetch_checkpoint(run_id: str, ckpt_stem: str, dst_dir: Optional[Path]=None, overwrite: bool=False, ckpt_dir: str='checkpoints', hist_dir: str='checkpoints/history', hist_subdir: str='history') -> Path

   自动为 ckpt_stem 添加 .pth. ``epoch_`` 前缀使用历史目录, 其他名称使用常规检查点目录; .pt 文件应调用 fetch_run_artifact.

   :param run_id: 检查点所属 run.
   :param ckpt_stem: 不带 .pth 后缀的检查点名称.
   :param dst_dir: 可选本地规范目录断言; 历史文件再拼接 hist_subdir.
   :param overwrite: 是否要求底层重新下载, 默认允许复用.
   :param ckpt_dir: 远端常规检查点相对目录.
   :param hist_dir: 远端历史检查点相对目录.
   :param hist_subdir: 检查历史文件 dst_dir 时使用的本地子目录名称.
   :returns: 共享检查点文件 Path.
   :raises ValueError: 请求目标不等于规范共享位置或路径不合法.
   :raises mlflow.exceptions.MlflowException: 查询或下载失败.

.. py:function:: fetch_snapshot(run_id: str, run_name: str, dst_dir: Optional[Path]=None, overwrite: bool=False, snapshot_dir: str='snapshots') -> Path

   下载同名 .py 配置及存在的同名 .json. 未找到目标 .py 时, 可以使用唯一的历史 .py/.json 配置对.

   :param run_id: 配置所属 run.
   :param run_name: 首先查找的配置文件主名.
   :param dst_dir: 可选规范本地目录断言, 不另选输出目录.
   :param overwrite: 是否强制重新下载配置文件.
   :param snapshot_dir: 远端配置产物相对目录.
   :returns: .py 配置文件的共享 Path.
   :raises ValueError: 历史配置对有多组, 或目标目录不符合共享位置.
   :raises mlflow.exceptions.MlflowException: 列举产物或下载失败.


deeplore_core.mlflow_storage
----------------------------

.. py:module:: deeplore_core.mlflow_storage

.. py:function:: get_storage_root() -> Path

   解析并创建共享存储根目录, 使用 .local 身份记录防止不同 tracking/registry 配置复用同一根目录. 默认 /data/Projects/mlflow, 项目统一采用默认位置.

   :returns: 共享根目录的绝对 Path. DEEPLORE_MLFLOW_ROOT 若设置, 必须解析到 /data 下的绝对路径.
   :raises ValueError: 根目录不在 /data, 或与已有服务器身份不一致.

.. py:function:: get_run_directory(run_id: str | None=None, *, experiment_name: str | None=None, run_name: str | None=None) -> Path

   按 run_id 查询并绑定共享目录, 或在创建 run 前预留指定名称的位置. 已绑定 run_id 的目录必须用 run_id 打开.

   :param run_id: 可选 run 标识; 传入时以服务器身份为准.
   :param experiment_name: 未传 run_id 时必填; 同时传入时用于核验所属 experiment.
   :param run_name: 未传 run_id 时必填; 同时传入时用于核验名称.
   :returns: 共享 run 目录的绝对 Path; 可能创建目录并写本地身份记录.
   :raises ValueError: 必要身份缺失, 名称不安全或服务器身份不匹配.
   :raises FileExistsError: 尝试仅按名称打开已绑定 run_id 的目录.
   :raises mlflow.exceptions.MlflowException: run 或 experiment 查询失败.

.. py:function:: get_run_artifact_path(run_id: str, artifact_path: Path) -> Path

   在规范共享 run 中解析产物路径. 不下载文件, 不保证目标文件或父目录已存在.

   :param run_id: 产物所属 run.
   :param artifact_path: 安全相对路径; 不允许绝对路径, .. 或 .local.
   :returns: 共享 run 中的产物 Path.
   :raises ValueError: 路径不安全或经符号链接解析后逃逸 run 目录.

.. py:function:: get_evaluation_artifact_path(benchmark: str, timestamp: str) -> Path

   构造评估产物相对路径, 不创建目录.

   :param benchmark: 单个安全路径分量组成的精确 benchmark 名称.
   :param timestamp: 协调世界时 (Coordinated Universal Time, UTC) 字符串 YYYYMMDDTHHMMSSffffffZ, 微秒部分固定六位.
   :returns: outputs/<benchmark>/<timestamp> 的相对 Path.
   :raises ValueError: 名称或时间戳格式/日期无效.

.. py:function:: create_evaluation_directory(run_id: str, benchmark: str) -> Path

   为一次评估独占创建带 UTC 时间戳的共享产物目录. 时间戳冲突时递增微秒, 不复用旧结果.

   :param run_id: 输出所属 run.
   :param benchmark: 单个安全路径分量组成的 benchmark 名称.
   :returns: 新建的共享 run 输出目录 Path.
   :raises ValueError: benchmark 名称或共享 run 位置无效.
   :raises PermissionError: 无法继承父目录权限.

.. py:function:: get_model_directory(registered_model_name: str, version: str) -> Path

   解析数字模型版本的规范目标位置. 创建父目录, 不创建或标记模型版本目录为完整.

   :param registered_model_name: 安全 Registered Model 名称.
   :param version: 正整数字符串, 不带前导零.
   :returns: 共享 models/<registered_model_name>/<version> 的绝对 Path.
   :raises ValueError: 名称, 版本或共享位置无效.

.. py:function:: create_model_staging_directory(registered_model_name: str) -> Path

   在共享模型目录的 .staging 下创建唯一暂存目录, 用于导出, 发布或下载.

   :param registered_model_name: 安全 Registered Model 名称.
   :returns: 新暂存目录的绝对 Path.
   :raises ValueError: 名称或共享存储位置无效.
   :raises PermissionError: 无法继承父目录权限.

.. py:function:: calculate_file_digest(path: Path) -> str

   分块读取文件并计算完整内容 MD5, 不把整个文件加载到内存.

   :param path: 要读取的文件 Path.
   :returns: 32 位小写十六进制字符串, 不附加 .dir.
   :raises OSError: 文件无法打开或读取.

.. py:function:: inherit_permissions(path: Path) -> None

   让现有路径继承直接父目录的属组, 权限和访问控制列表 (Access Control List, ACL). 普通文件不保留执行位; 新目录继承目录默认 ACL. 依赖系统 getfacl/setfacl.

   :param path: 已经存在的文件或目录.
   :returns: None.
   :raises: ``OSError`` 表示路径访问, 属组修改或权限修改失败;
            ``PermissionError`` 表示修改后仍未继承父目录属组;
            ``subprocess.CalledProcessError`` 表示 ACL 命令执行失败.

.. py:function:: validate_shared_path(path: Path) -> Path

   解析并验证路径位于配置的共享根目录内. 根目录身份检查可能创建本地管理状态.

   :param path: 待验证路径, 允许尚未存在的目标.
   :returns: 解析后的绝对 Path.
   :raises ValueError: 路径逃逸共享根目录或根目录服务器身份不匹配.

.. py:function:: validate_run_output_path(path: Path) -> Path

   要求派生产物属于已记录 run 身份的共享目录, 不接受独立目录或模型版本目录.

   :param path: 候选输出文件或目录.
   :returns: 属于共享 run 的绝对 Path.
   :raises ValueError: 路径不在共享根目录或祖先目录中找不到匹配的 run 身份记录.

.. py:function:: write_model_metadata(directory: Path, identity: dict[str, Any]) -> None

   枚举包内文件并写入 .local/metadata.json 完整性清单, 包括身份, complete 标记和各文件大小/完整 MD5. 忽略 .local 子树, 不上传此管理记录, 不代表远端发布已经完成.

   :param directory: 包含 MLmodel 的本地完整模型包目录.
   :param identity: 应记录的模型身份键值, 例如名称, 数字版本, source 和 run_id.
   :returns: None.
   :raises FileNotFoundError: 目录缺少 MLmodel.
   :raises ValueError: 非 .local 包内容含符号链接.
   :raises OSError: 读取文件, 继承权限或写入清单失败.

.. py:function:: validate_model_directory(directory: Path, identity: dict[str, Any]) -> bool

   核对完整标记, 身份和清单内各文件的路径, 类型, 大小及完整 MD5. 不修复目录, 不检查清单之外是否增加了额外文件.

   :param directory: 候选模型包目录.
   :param identity: 必须与清单匹配的预期身份键值.
   :returns: 清单完整且所有登记文件匹配时为 True; 缺少清单/MLmodel, 文件缺失或内容不一致时为 False.
   :raises ValueError: 身份冲突, 元数据对象无效或清单包含不安全相对路径.
   :raises OSError: 文件或清单读取失败.


deeplore_core.dvc
-----------------

.. py:module:: deeplore_core.dvc

.. py:exception:: DatasetVersionError

   继承 ``RuntimeError``. 数据集版本文件缺失, 格式无效或内容不一致时抛出.

.. py:function:: read_dataset_meta(dvc_file: Path, yaml_file: Path) -> dict[str, Any]

   读取旧布局 <name>.dvc 与旁置 <name>.yaml 的身份信息. 不计算工作区真实内容, 不作为 metadata.yaml + samples/<split>.dvc 新布局的全量发布校验器.

   :param dvc_file: 旧布局 .dvc 指针文件.
   :param yaml_file: 旁置版本 .yaml 文件, 必须包含 version.
   :returns: 包含 name, version, md5, metrics 的对象; name 未给出时使用 yaml_file.stem, metrics 缺失时为 None.
   :raises deeplore_core.dvc.DatasetVersionError: 文件缺失, 内容无法解析, .dvc 缺少摘要或 YAML 缺少版本.
