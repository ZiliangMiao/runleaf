
.. _rest-api:

========
REST API
========


MLflow REST (Representational State Transfer) API 用于创建和查询 experiments/runs, 以及记录参数, 指标和产物.
当前定制服务器还提供 Dataset 发布, Evaluation 和 Benchmark API, 见 :ref:`deeplore-rest-api`.
例如, 向 ``http://192.168.110.148:5050/api/2.0/mlflow/experiments/search`` 发送 POST 请求可以查询原生 experiments.
该地址对应仓库中的部署配置, 使用其他部署时替换服务器地址.

.. important::
    The MLflow REST API requires content type ``application/json`` for all POST requests.

.. contents:: Table of Contents
    :local:
    :depth: 1

===========================


.. _deeplore-rest-api:

Deeplore HTTP API
=================

本节记录定制 Tracking Server 的 Dataset 发布, Evaluation 和 Benchmark 接口. Python 函数签名, 参数和使用示例见 :doc:`Python API 和使用说明 <python_api/deeplore_core>`.

接口前缀为 ``/api/2.0/deeplore``, 页面内部也使用 ``/ajax-api/2.0/deeplore``. 若配置静态路径前缀, 两者还需加上该前缀. 原生接口仍使用 ``/api/2.0/mlflow``, 位于本文后半部分. 以下约定以当前实现为准.

对象和职责
----------

================ ========================================================== ============================================
对象             含义                                                       记录位置
================ ========================================================== ============================================
Experiment       指标可以比较的一组 runs, 名称为 ``<project>-<experiment>`` 原生 MLflow experiment
Run              一次训练设置固定的训练或权重变换过程                       原生 MLflow run
Dataset version  数据集的一次整体发布, train/val/test 各自保存内容摘要      定制数据集登记表, Git tag, ``metadata.yaml``
Dataset input    某 run 使用的数据及用途                                    原生 MLflow dataset input
Evaluation       某 run 的最佳检查点在指定测试内容上的评估结果              定制 evaluation 表
Benchmark        以 ``(dataset_name, test_hash)`` 组织的跨 run 比较         从数据集和 evaluation 聚合
Model Monitor    训练和验证指标, 包括最佳检查点选择过程                     原生 run metrics
System Monitor   训练期间硬件资源指标                                       原生 run metrics
Registered Model 同一交付用途的模型版本容器                                 原生 Model Registry
Model Version    一个具体模型包的数字版本                                   原生 Model Registry
================ ========================================================== ============================================

训练设置变化, 稀疏化或量化导致权重变化时, 按业务约定建立新 run. 设置不变的断点续训重连原 run. ``base_run`` 表示训练设置参考关系, 不表示预训练权重来源. 测试集内容变化后, 需要重新评估才能与该内容上的其他结果比较; Benchmark 页面不会自动重跑评估.

Data Version Control (DVC) 管理数据内容, Git 管理 ``.dvc`` 指针和发布元数据. 业务内容摘要使用 Message Digest Algorithm 5 (MD5): 文件为 32 位小写十六进制, DVC 目录摘要保留 ``.dir``. 不截断摘要, 不将其他算法的历史摘要改名冒充 MD5.

服务端配置
----------

运行前提
~~~~~~~~

定制 Dataset, Evaluation 和 Benchmark API 需要基于 Structured Query Language (SQL) 数据库的 tracking 后端, 当前部署使用 SQLite. 数据集发布还要求服务进程可以读写仓库, 访问 Git/DVC 远端并持有相应凭据.

================================================= ========================================================
配置                                              含义
================================================= ========================================================
``DEEPLORE_DATASET_REPOS``                        数据仓库根目录列表, Linux 上以 ``:`` 分隔
``DEEPLORE_DATASET_SKIP_GIT_HOOKS=true``          发布提交使用 ``--no-verify``, 仅在部署环境明确需要时配置
``XDG_CACHE_HOME``, ``TMPDIR``, ``TMP``, ``TEMP`` 通用缓存和临时目录, 物理存储必须在 ``/data``
``DVC_SITE_CACHE_DIR``                            DVC 站点缓存目录, 同样放在 ``/data``
================================================= ========================================================

当前部署文件为 ``/data/Projects/deeplore-mlflow/deploy/local/docker-compose.yml``, 监听 ``0.0.0.0:5050``. 容器内部也显式配置 ``/data`` 上的缓存和临时目录. 这些 API 没有独立的访问凭据配置入口, 访问策略由实际服务器及其前置服务提供.

数据集结构和发布
----------------

目录契约
~~~~~~~~

数据集位于配置仓库的 ``data/<name>/``, 由 ``metadata.yaml`` 被发现. 样本文件与 ``_reference.json`` 应由数据构建脚本确定性生成, 不写入构建时间或整体发布版本等无关内容.

.. code:: text

   data/inat/
     metadata.yaml
     assets/
     assets.dvc
     annotations/
     annotations.dvc
     samples/
       train/
         data.json
         _reference.json
       train.dvc
       val/
         data.json
         _reference.json
       val.dvc
       test/
         data.json
         _reference.json
       test.dvc

实际文件名是单数 ``_reference.json``. 每个存在的 split 使用 ``data.json`` 或 ``shard_000000.json`` 等分片, 两种形式不能并存. 分片从 0 连续编号, 补零宽度一致. assets, annotations 和三个 split 均按存在情况发布; 缺少目录会产生 warning, 没有任何 split 也不会单独阻断发布.

.. code:: json

   {
     "hash": "md5",
     "files": {
       "assets/images/image-0001.jpg": "0123456789abcdef0123456789abcdef"
     }
   }

上面的摘要仅示意格式, 使用时必须替换成真实文件 MD5. 没有外部依赖时保留 ``"files": {}``. 引用路径相对数据集根目录, 不能是绝对路径, 不能含 ``..``, 不能指向 ``samples/``. 发布检查会逐个计算引用文件内容摘要. 自动发现依赖的范围是样本内容中以 ``assets/`` 或 ``annotations/`` 开头的字符串, 不会分析任意训练代码的文件读取行为.

发布后的元数据示例:

.. code:: yaml

   name: inat
   source: https://www.inaturalist.org/
   root: /data/Projects/deepdet-dataset/data/inat
   version: v1.0.0
   hashes:
     - train: "0123456789abcdef0123456789abcdef.dir"
     - val: "123456789abcdef0123456789abcdef0.dir"
     - test: null
   metrics: ["AP"]
   changelog:
     - v1.0.0: initial release

``AP`` 表示平均精度 (Average Precision). 元数据内的 ``hashes`` 是列表, HTTP 版本记录顶层的 ``hashes`` 是对象. 正常发布生成的这两种结构均保留 train/val/test 的完整摘要, 缺失为 null. assets/annotations 的快照由 ``.dvc`` 和 Git tag 关联, 不重复写入 metadata.hashes. ``version``, ``hashes`` 和新增 changelog 由发布流程生成, 不手工伪造.

版本和检查
~~~~~~~~~~

版本使用语义化版本 (Semantic Versioning) 形式 ``vX.Y.Z``, 无多余前导零. 业务上, X 表示不兼容的语义或读取约定变化, Y 表示数据组成或划分变化, Z 表示已有规则下的错误修正. 工具只校验格式和递增关系, 不判断变更应该属于哪一级.

下一版本只能选择 patch+1, minor+1 且 patch 归零, 或 major+1 且其余归零. 尚无版本时允许 ``v0.0.1``, ``v0.1.0``, ``v1.0.0``. 当前版本必须与 changelog 最高版本一致; 已存在于本地 metadata, 本地 tag 或 MLflow 登记表的版本不能作为新版本重复发布.

检查要求仓库已初始化 Git/DVC, HEAD 位于分支上, 暂存区不包含本次数据集发布以外的变动. 不要求整个工作树没有改动. Check 会检查样本结构和引用内容, 但不访问远端 tag, 也不保证后续 DVC/Git 推送成功.

页面操作
~~~~~~~~

1. 打开 ``Datasets``, 选择数据集. 新数据集需要先在配置仓库建立 ``data/<name>/metadata.yaml``, 页面当前没有创建表单. 首次发布前 metadata 至少包含与目录一致的 name, 省略 version, changelog 使用空列表; 不要把前面的已发布示例的版本和摘要复制为初始状态.
2. 在 ``Metadata version`` 选择已发布版本或可用本地元数据, 查看 Source, Directory, Metrics, Hashes 和 Changelog. 页面只读, 显示的 hash 不是实时重算结果.
3. 修改本地描述或配置后, 在 ``Release a new version`` 中选择下一版本, 填写 ``Change description``.
4. 点击 ``Check`` 查看 error/warning. error 阻断发布, warning 不阻断.
5. 点击 ``Release`` 并确认, 等待任务成功和新版本登记. 仅 Check 成功不表示已发布.

完整发布顺序为: 校验, 对存在目录执行 DVC 跟踪并移除缺失目录的旧指针, 更新 metadata, 暂存本次发布文件, 创建提交与带注释 tag, 先推送 DVC 数据, 再原子推送当前分支及本次 tag, 最后从 tag 对应提交读取元数据并登记 MLflow.

发布器生成提交消息 ``dataset(<name>): release <version>, <change>`` 和 tag ``<name>-<version>``. 这是发布器的既有行为, 点击 Release 或执行 release 命令会实际提交和推送仓库. 它不会自动把无关构建脚本纳入发布提交.

发布失败与恢复
~~~~~~~~~~~~~~

================================= ==================================================================
失败位置                          当前行为与处理
================================= ==================================================================
校验失败                          不进入后续发布步骤, 修复 findings 后重新检查
DVC/metadata/暂存/commit 阶段失败 恢复原 metadata 并取消本次暂存, DVC 指针可能保留变化, 需要检查仓库
commit 已成功, tag 失败           保留 commit, 按错误提示修复 tag 后再继续
DVC 或 Git 推送失败               保留 commit/tag, 修复远端或凭据问题后, 重新提交同版本 release
推送成功, MLflow 登记失败         保留远端发布, 重新提交同版本 release 完成登记
================================= ==================================================================

自动续发要求版本尚未登记, 本地发布 tag 指向当前 HEAD, 且 tag 内 metadata.version 一致. 满足时跳过检查到 commit/tag 的步骤, 重新执行推送和登记. HEAD 已移动或 tag 缺失时, 不能假设会自动恢复. 目前没有专用 Retry 按钮或接口, 页面下一版本列表也不一定包含失败版本; 同版本恢复使用下面的 HTTP API 或命令行.

Dataset HTTP API
~~~~~~~~~~~~~~~~

以下路径统一添加前缀 ``/api/2.0/deeplore``, 页面内部也可用 ``/ajax-api/2.0/deeplore``. POST 使用 ``Content-Type: application/json``. 成功返回 HTTP 200.

==== ============================== ==================================================================================
方法 相对路径                       请求和响应
==== ============================== ==================================================================================
GET  ``/datasets``                  返回 ``{"repos": [...], "datasets": [...]}``
GET  ``/datasets/<name>/versions``  返回 ``{"versions": [...]}``, 按登记时间降序; 未知名称返回空列表
POST ``/datasets/<name>/releases``  必填 version/change, 可选 dry_run; 返回 ``{"job": {...}}``
GET  ``/dataset-releases``          可选 ``?name=...``, 返回最近最多 20 个任务 ``{"jobs": [...]}``, 列表不包含日志正文
GET  ``/dataset-releases/<job_id>`` 返回带完整 log/findings 的 ``{"job": {...}}``
POST ``/datasets/versions``         登记已经推送的版本, 返回 ``{"version": {...}}``; 不负责 DVC/Git 上传
==== ============================== ==================================================================================

Dataset summary 包含 ``name``, ``repo``, ``units``, ``metadata``, ``next_versions``, ``error``, ``latest_release``, ``release_count``, ``changelog``. ``units`` 的键为 assets/annotations/train/val/test. ``next_versions`` 根据本地 metadata.version 计算. 数据库仍有记录而仓库不再可用时, summary 仍显示, 但 repo/metadata 为 null, units 为空, 不可从页面发布.

版本记录包含 ``name``, ``version``, ``change``, ``hashes``, ``metadata``, ``git_repo``, ``git_tag``, ``git_commit``, ``created_at``. ``created_at`` 为 Unix 毫秒. 历史补录版本可能只有 hashes.test, 其他 split 键缺失, 且没有完整 metadata 或 Git 信息. ``latest_release`` 取最新登记记录, 不等于对版本号取最大值.

发布请求示例:

.. code:: http

   POST /api/2.0/deeplore/datasets/inat/releases HTTP/1.1
   Content-Type: application/json

   {"version":"v1.0.1","change":"fix labels","dry_run":true}

``dry_run`` 默认 false, 必须传 JSON 布尔值, 不要传字符串 ``"false"``. 改为 false 才会实际发布. 响应只表示已建立任务, 不代表完成:

.. code:: json

   {
     "job": {
       "job_id": "<job_id>",
       "status": "pending",
       "dry_run": true,
       "steps": {},
       "findings": [],
       "error": null
     }
   }

上面省略了 repo/name/version/change/pid/log/created_at/updated_at. ``status`` 为 pending/running/succeeded/failed. 轮询单任务直到结束; HTTP 200 中也可能携带 failed 任务. ``steps`` 使用字符串键 ``"2"`` 到 ``"8"``, 依次对应检查, DVC, metadata, 暂存, commit/tag, 推送, 登记; 值为 running/done/failed/skipped. Finding 结构为 ``{"level":"error|warning","check":"...","message":"..."}``.

同仓库只允许一个 pending/running 任务. worker 每 2 秒报告心跳; 查询或再次启动任务时, 超过 120 秒无报告的活动任务会被标记 failed, 之后应先检查仓库实际状态.

``POST /datasets/versions`` 必填 ``name``, ``version``, ``change``, ``hashes``, ``metadata``, ``git_repo``, ``git_tag``, ``git_commit``. metadata 必须是对象. 同 ``(name, version)`` 可再次登记补全元数据, 但已建立的 split 内容摘要不可替换. 此接口不重算文件摘要, 不验证远端是否已收到内容, 应由发布器在推送成功后调用.

命令行操作
~~~~~~~~~~

命令行界面 (Command-Line Interface, CLI) 在执行命令的机器操作仓库, 通过 HTTP 查询并登记版本, 不创建服务器 release job.

.. code:: bash

   python -m mlflow.deeplore.dataset_release check \
     --repo /data/Projects/deepdet-dataset \
     --name inat \
     --version v1.0.1 \
     --change "fix labels" \
     --tracking-uri http://192.168.110.148:5050

将 ``check`` 改为 ``release`` 执行真实提交, 推送和登记. Check 也需要 tracking 地址读取已登记版本. ``--tracking-uri`` 可由 ``MLFLOW_TRACKING_URI`` 提供; ``--skip-hooks`` 显式跳过 Git hooks. 从普通官方 MLflow 安装运行此模块会缺少定制发布入口.

Evaluation API 和结果上传
-------------------------

HTTP 接口
~~~~~~~~~

使用相同 ``/api/2.0/deeplore`` 前缀, 成功均返回 HTTP 200.

==== ================================ =================================================================================
方法 相对路径                         响应
==== ================================ =================================================================================
GET  ``/runs/<run_id>/evaluations``   ``{"evaluations": [...]}``, 已知评估时间降序, 未知时间最后, 无分页
POST ``/runs/<run_id>/evaluations``   ``{"evaluation": {...}, "created": true或false, "action": "created"或"updated"}``
GET  ``/evaluations/<evaluation_id>`` ``{"evaluation": {...}}``
==== ================================ =================================================================================

POST 请求字段:

=================== ==== ============================================================================
字段                必填 约束
=================== ==== ============================================================================
``dataset_name``    是   精确数据集名称, 非空且无首尾空白, 最长 256
``dataset_version`` 是   已知版本, 非空且无首尾空白, 最长 64
``test_hash``       否   完整 MD5, 可带 ``.dir``; 提供时必须匹配该版本登记内容
``ckpt_path``       是   所属 run 已上传的最佳检查点相对路径, 最长 1024
``ckpt_hash``       是   实际评估检查点的完整文件 MD5, 不带 ``.dir``
``evaluated_at``    是   非负整数 Unix 毫秒, 不接受布尔值
``metrics``         是   非空对象, 名称非空, 值为有限数值, 不接受布尔值或 null
``params``          否   默认 ``{}``, 键为非空字符串, 平铺键值, 值可为字符串, 有限数值, 布尔值或 null
=================== ==== ============================================================================

HTTP 写入口目前只接受文件名 ``best_ckpt.pth`` 或 ``best.pt``, 例如 ``checkpoints/best_ckpt.pth``. 不接受绝对路径, ``..``, 反斜杠, 冒号或非标准相对路径. 不支持直接把任意 ONNX 或部署模型写入这个接口.

若省略 test_hash, 服务器从已登记版本读取 test 内容摘要. 历史原生 evaluation input 或服务器当前数据集元数据可作为兼容证据, 但只知道版本号或 changelog 不足以证明 test 内容. 正常流程应先完成数据集版本登记.

服务器会验证数据集身份, test_hash 与登记内容的对应关系, 检查点在该 run 中存在以及 ckpt_hash 格式. 它不会重新读取工作区测试内容, 也不会下载检查点重算 ckpt_hash. 检查点内容校验使用客户端函数 :py:func:`deeplore_core.mlflow_ops.log_benchmark_evaluation`.

请求体示例, 其中名称, 版本, 摘要和时间必须替换为实际评估数据:

.. code:: json

   {
     "dataset_name": "inat",
     "dataset_version": "v1.0.0",
     "test_hash": "0123456789abcdef0123456789abcdef.dir",
     "ckpt_path": "checkpoints/best_ckpt.pth",
     "ckpt_hash": "123456789abcdef0123456789abcdef0",
     "evaluated_at": 1791331200000,
     "metrics": {"AP": 0.42},
     "params": {"batch_size": 16}
   }

返回值和覆盖规则
~~~~~~~~~~~~~~~~

Evaluation 对象字段为:

.. code:: text

   evaluation_id, run_id, dataset_name, dataset_version,
   association_status, benchmark_name, test_hash,
   ckpt_path, ckpt_hash, evaluated_at, metrics, params, created_at

POST 的响应外层包含 ``created`` 布尔值和 ``action`` 字符串. 新建为 true/created, 覆盖为 false/updated. 新写入的 association_status 为 confirmed, benchmark_name 等于 dataset_name. evaluation_id 由服务器分配, created_at 为首次创建的 Unix 毫秒时间. 历史导入记录可能为 pending 或存在空字段, 读取接口保留这些记录.

对外覆盖语义是 ``(run_id, dataset_name, test_hash)``. 相同 run, 相同数据集, 相同 test 内容的重复评估覆盖原记录, 即使 dataset_version 不同. 覆盖保留 evaluation_id 和 created_at, 替换版本, 检查点, 参数, 指标和 evaluated_at. 服务端不比较 evaluated_at 新旧, 后提交的较早结果也会覆盖. 不同 test_hash 独立保存.

页面入口为 ``Run -> Evaluations``, 按数据集分组并按评估时间降序展示. 展开记录查看 Params 和 Metrics, 点击检查点链接进入 Artifacts.

这个表不保存每次覆盖的历史. 如果要追溯每次评估的报告和参数快照, 将它们上传到独立时间戳产物目录.

Benchmark 比较和 Lineage
------------------------

Benchmark 查询
~~~~~~~~~~~~~~

``GET /api/2.0/deeplore/experiments/<experiment_id>/benchmarks`` 返回:

.. code:: json

   {
     "experiment_id": "<experiment_id>",
     "runs": [
       {"run_id": "<run_id>", "run_name": "r42-disable_mixup-r41-yolox_m", "run_num": 42}
     ],
     "benchmarks": [
       {
         "dataset_name": "inat",
         "test_hash": "0123456789abcdef0123456789abcdef.dir",
         "dataset_versions": ["v1.0.0", "v1.0.1"],
         "first_dataset_version": "v1.0.0",
         "metric_names": ["AP"],
         "evaluations": []
       }
     ]
   }

runs 包含该 experiment 的全部 active runs, 包括未评估 run. 返回的 run_num 是整数或 null, 按编号升序, 缺失值最后. benchmarks 以 ``(dataset_name, test_hash)`` 分组, evaluations 为完整 Evaluation 对象, 仅纳入该 experiment 的 active runs 和 confirmed 记录.

目录来自全局已登记版本及服务器发现的本地数据集, 因此可能存在 evaluations 为空的组. 同 test hash 的多个版本合并. 只有一个版本时 first_dataset_version 直接取该版本; 多版本时按语义版本取最早值, 其中任一版本无法解析则返回 null. 不同 hash 不可当成同一测试条件直接比较.

页面操作: Experiment -> ``Benchmarks``, 选择一个或多个 Dataset, 为每个选择 Version 和 Metrics, 切换 Table/Chart, 按编号或指标排序, 显示/隐藏 runs, 选择 baseline 查看差值. Version 选项显示该 hash 首次出现的版本, 并非每个发布版本独立一列. 缺少 first_dataset_version 的组当前不进入页面选项.

Python 接入和页面使用
---------------------

训练与模型操作的 Python API, Model/System Monitor, Lineage 和 Model Registry 使用说明见 :doc:`Python API 和使用说明 <python_api/deeplore_core>`. 评估记录的客户端内容校验使用 :py:func:`deeplore_core.mlflow_ops.log_benchmark_evaluation`; 服务器验证登记身份和 artifact 存在, 不替代客户端重新读取实际评估文件.

HTTP 错误和功能边界
-------------------

HTTP 错误体采用 ``{"error_code": "...", "message": "..."}``. 发布任务的后台错误还需读取 job.status/error/findings/log.

====================================== =========================================================
返回                                   含义
====================================== =========================================================
HTTP 400 / ``INVALID_PARAMETER_VALUE`` 请求字段, 摘要, 路径, 版本或发布并发条件不满足
HTTP 404 / ``RESOURCE_DOES_NOT_EXIST`` run, experiment, evaluation, job 或待发布本地数据集不存在
HTTP 500 / ``FEATURE_DISABLED``        当前 tracking 后端不支持这些 SQL 接口
HTTP 200 且 job.status 为 failed       任务创建或查询成功, 但后台发布失败
====================================== =========================================================

当前没有 Dataset/Version/Evaluation 删除 API. 移除 split 通过新版本发布表达: 工作区目录缺失时移除旧指针并登记 null hash, 不删除历史版本. 没有独立 Retry 接口; 恢复按前文同版本 release 条件执行.

``MLflow焚决.md`` 中的 dataset_hash/checkpoint_path/checkpoint_hash/evaluation_time 对应当前 HTTP 字段 test_hash/ckpt_path/ckpt_hash/evaluated_at. 当前 Evaluation 写入限定 best_ckpt.pth/best.pt, Benchmark 查询和比较页面已经实现. 训练前全量校验, validation 变更后自动重选检查点与重评估仍由调用方处理.

实现索引
--------

服务端实现位于 ``/data/Projects/deeplore-mlflow/mlflow/deeplore/``: ``dataset_api.py`` 负责路由和任务, ``dataset_release.py`` 负责发布恢复, ``dataset_registry.py`` 负责版本登记, ``evaluation_api.py`` 和 ``evaluation_registry.py`` 负责评估写入, ``benchmark_api.py`` 负责比较查询.

.. _mlflowMlflowServicecreateExperiment:

Create Experiment
=================


+-----------------------------------+-------------+
|             Endpoint              | HTTP Method |
+===================================+=============+
| ``2.0/mlflow/experiments/create`` | ``POST``    |
+-----------------------------------+-------------+

Create an experiment with a name. Returns the ID of the newly created experiment.
Validates that another experiment with the same name does not already exist and fails
if another experiment with the same name already exists.


Throws ``RESOURCE_ALREADY_EXISTS`` if a experiment with the given name exists.




.. _mlflowCreateExperiment:

Request Structure
-----------------






+-------------------+----------------------------------------+------------------------------------------------------------------------------------------------+
|    Field Name     |                  Type                  |                                          Description                                           |
+===================+========================================+================================================================================================+
| name              | ``STRING``                             | Experiment name.                                                                               |
|                   |                                        | This field is required.                                                                        |
|                   |                                        |                                                                                                |
+-------------------+----------------------------------------+------------------------------------------------------------------------------------------------+
| artifact_location | ``STRING``                             | Location where all artifacts for the experiment are stored.                                    |
|                   |                                        | If not provided, the remote server will select an appropriate default.                         |
+-------------------+----------------------------------------+------------------------------------------------------------------------------------------------+
| tags              | An array of :ref:`mlflowexperimenttag` | A collection of tags to set on the experiment. Maximum tag size and number of tags per request |
|                   |                                        | depends on the storage backend. All storage backends are guaranteed to support tag keys up     |
|                   |                                        | to 250 bytes in size and tag values up to 5000 bytes in size. All storage backends are also    |
|                   |                                        | guaranteed to support up to 20 tags per request.                                               |
+-------------------+----------------------------------------+------------------------------------------------------------------------------------------------+

.. _mlflowCreateExperimentResponse:

Response Structure
------------------






+---------------+------------+---------------------------------------+
|  Field Name   |    Type    |              Description              |
+===============+============+=======================================+
| experiment_id | ``STRING`` | Unique identifier for the experiment. |
+---------------+------------+---------------------------------------+

===========================



.. _mlflowMlflowServicesearchExperiments:

Search Experiments
==================


+-----------------------------------+-------------+
|             Endpoint              | HTTP Method |
+===================================+=============+
| ``2.0/mlflow/experiments/search`` | ``POST``    |
+-----------------------------------+-------------+






.. _mlflowSearchExperiments:

Request Structure
-----------------






+-------------+------------------------+--------------------------------------------------------------------------------------------+
| Field Name  |          Type          |                                        Description                                         |
+=============+========================+============================================================================================+
| max_results | ``INT64``              | Maximum number of experiments desired.                                                     |
|             |                        | Servers may select a desired default `max_results` value. All servers are                  |
|             |                        | guaranteed to support a `max_results` threshold of at least 1,000 but may                  |
|             |                        | support more. Callers of this endpoint are encouraged to pass max_results                  |
|             |                        | explicitly and leverage page_token to iterate through experiments.                         |
+-------------+------------------------+--------------------------------------------------------------------------------------------+
| page_token  | ``STRING``             | Token indicating the page of experiments to fetch                                          |
+-------------+------------------------+--------------------------------------------------------------------------------------------+
| filter      | ``STRING``             | A filter expression over experiment attributes and tags that allows returning a subset of  |
|             |                        | experiments. The syntax is a subset of SQL that supports ANDing together binary operations |
|             |                        | between an attribute or tag, and a constant.                                               |
|             |                        |                                                                                            |
|             |                        | Example: ``name LIKE 'test-%' AND tags.key = 'value'``                                     |
|             |                        |                                                                                            |
|             |                        | You can select columns with special characters (hyphen, space, period, etc.) by using      |
|             |                        | double quotes or backticks.                                                                |
|             |                        |                                                                                            |
|             |                        | Example: ``tags."extra-key" = 'value'`` or ``tags.`extra-key` = 'value'``                  |
|             |                        |                                                                                            |
|             |                        | Supported operators are ``=``, ``!=``, ``LIKE``, and ``ILIKE``.                            |
+-------------+------------------------+--------------------------------------------------------------------------------------------+
| order_by    | An array of ``STRING`` | List of columns for ordering search results, which can include experiment name and id      |
|             |                        | with an optional "DESC" or "ASC" annotation, where "ASC" is the default.                   |
|             |                        | Tiebreaks are done by experiment id DESC.                                                  |
+-------------+------------------------+--------------------------------------------------------------------------------------------+
| view_type   | :ref:`mlflowviewtype`  | Qualifier for type of experiments to be returned.                                          |
|             |                        | If unspecified, return only active experiments.                                            |
+-------------+------------------------+--------------------------------------------------------------------------------------------+

.. _mlflowSearchExperimentsResponse:

Response Structure
------------------






+-----------------+-------------------------------------+----------------------------------------------------------------------------+
|   Field Name    |                Type                 |                                Description                                 |
+=================+=====================================+============================================================================+
| experiments     | An array of :ref:`mlflowexperiment` | Experiments that match the search criteria                                 |
+-----------------+-------------------------------------+----------------------------------------------------------------------------+
| next_page_token | ``STRING``                          | Token that can be used to retrieve the next page of experiments.           |
|                 |                                     | An empty token means that no more experiments are available for retrieval. |
+-----------------+-------------------------------------+----------------------------------------------------------------------------+

===========================



.. _mlflowMlflowServicegetExperiment:

Get Experiment
==============


+--------------------------------+-------------+
|            Endpoint            | HTTP Method |
+================================+=============+
| ``2.0/mlflow/experiments/get`` | ``GET``     |
+--------------------------------+-------------+

Get metadata for an experiment. This method works on deleted experiments.




.. _mlflowGetExperiment:

Request Structure
-----------------






+---------------+------------+----------------------------------+
|  Field Name   |    Type    |           Description            |
+===============+============+==================================+
| experiment_id | ``STRING`` | ID of the associated experiment. |
|               |            | This field is required.          |
|               |            |                                  |
+---------------+------------+----------------------------------+

.. _mlflowGetExperimentResponse:

Response Structure
------------------






+------------+-------------------------+---------------------+
| Field Name |          Type           |     Description     |
+============+=========================+=====================+
| experiment | :ref:`mlflowexperiment` | Experiment details. |
+------------+-------------------------+---------------------+

===========================



.. _mlflowMlflowServicegetExperimentByName:

Get Experiment By Name
======================


+----------------------------------------+-------------+
|                Endpoint                | HTTP Method |
+========================================+=============+
| ``2.0/mlflow/experiments/get-by-name`` | ``GET``     |
+----------------------------------------+-------------+

Get metadata for an experiment.

This endpoint will return deleted experiments, but prefers the active experiment
if an active and deleted experiment share the same name. If multiple deleted
experiments share the same name, the API will return one of them.

Throws ``RESOURCE_DOES_NOT_EXIST`` if no experiment with the specified name exists.




.. _mlflowGetExperimentByName:

Request Structure
-----------------






+-----------------+------------+------------------------------------+
|   Field Name    |    Type    |            Description             |
+=================+============+====================================+
| experiment_name | ``STRING`` | Name of the associated experiment. |
|                 |            | This field is required.            |
|                 |            |                                    |
+-----------------+------------+------------------------------------+

.. _mlflowGetExperimentByNameResponse:

Response Structure
------------------






+------------+-------------------------+---------------------+
| Field Name |          Type           |     Description     |
+============+=========================+=====================+
| experiment | :ref:`mlflowexperiment` | Experiment details. |
+------------+-------------------------+---------------------+

===========================



.. _mlflowMlflowServicedeleteExperiment:

Delete Experiment
=================


+-----------------------------------+-------------+
|             Endpoint              | HTTP Method |
+===================================+=============+
| ``2.0/mlflow/experiments/delete`` | ``POST``    |
+-----------------------------------+-------------+

Mark an experiment and associated metadata, runs, metrics, params, and tags for deletion.
If the experiment uses FileStore, artifacts associated with experiment are also deleted.




.. _mlflowDeleteExperiment:

Request Structure
-----------------






+---------------+------------+----------------------------------+
|  Field Name   |    Type    |           Description            |
+===============+============+==================================+
| experiment_id | ``STRING`` | ID of the associated experiment. |
|               |            | This field is required.          |
|               |            |                                  |
+---------------+------------+----------------------------------+

===========================



.. _mlflowMlflowServicerestoreExperiment:

Restore Experiment
==================


+------------------------------------+-------------+
|              Endpoint              | HTTP Method |
+====================================+=============+
| ``2.0/mlflow/experiments/restore`` | ``POST``    |
+------------------------------------+-------------+

Restore an experiment marked for deletion. This also restores
associated metadata, runs, metrics, params, and tags. If experiment uses FileStore, underlying
artifacts associated with experiment are also restored.

Throws ``RESOURCE_DOES_NOT_EXIST`` if experiment was never created or was permanently deleted.




.. _mlflowRestoreExperiment:

Request Structure
-----------------






+---------------+------------+----------------------------------+
|  Field Name   |    Type    |           Description            |
+===============+============+==================================+
| experiment_id | ``STRING`` | ID of the associated experiment. |
|               |            | This field is required.          |
|               |            |                                  |
+---------------+------------+----------------------------------+

===========================



.. _mlflowMlflowServiceupdateExperiment:

Update Experiment
=================


+-----------------------------------+-------------+
|             Endpoint              | HTTP Method |
+===================================+=============+
| ``2.0/mlflow/experiments/update`` | ``POST``    |
+-----------------------------------+-------------+

Update experiment metadata.




.. _mlflowUpdateExperiment:

Request Structure
-----------------






+---------------+------------+---------------------------------------------------------------------------------------------+
|  Field Name   |    Type    |                                         Description                                         |
+===============+============+=============================================================================================+
| experiment_id | ``STRING`` | ID of the associated experiment.                                                            |
|               |            | This field is required.                                                                     |
|               |            |                                                                                             |
+---------------+------------+---------------------------------------------------------------------------------------------+
| new_name      | ``STRING`` | If provided, the experiment's name is changed to the new name. The new name must be unique. |
+---------------+------------+---------------------------------------------------------------------------------------------+

===========================



.. _mlflowMlflowServicecreateRun:

Create Run
==========


+----------------------------+-------------+
|          Endpoint          | HTTP Method |
+============================+=============+
| ``2.0/mlflow/runs/create`` | ``POST``    |
+----------------------------+-------------+

Create a new run within an experiment. A run is usually a single execution of a
machine learning or data ETL pipeline. MLflow uses runs to track :ref:`mlflowParam`,
:ref:`mlflowMetric`, and :ref:`mlflowRunTag` associated with a single execution.




.. _mlflowCreateRun:

Request Structure
-----------------






+---------------+---------------------------------+----------------------------------------------------------------------------+
|  Field Name   |              Type               |                                Description                                 |
+===============+=================================+============================================================================+
| experiment_id | ``STRING``                      | ID of the associated experiment.                                           |
+---------------+---------------------------------+----------------------------------------------------------------------------+
| user_id       | ``STRING``                      | ID of the user executing the run.                                          |
|               |                                 | This field is deprecated as of MLflow 1.0, and will be removed in a future |
|               |                                 | MLflow release. Use 'mlflow.user' tag instead.                             |
+---------------+---------------------------------+----------------------------------------------------------------------------+
| run_name      | ``STRING``                      | Name of the run.                                                           |
+---------------+---------------------------------+----------------------------------------------------------------------------+
| start_time    | ``INT64``                       | Unix timestamp in milliseconds of when the run started.                    |
+---------------+---------------------------------+----------------------------------------------------------------------------+
| tags          | An array of :ref:`mlflowruntag` | Additional metadata for run.                                               |
+---------------+---------------------------------+----------------------------------------------------------------------------+

.. _mlflowCreateRunResponse:

Response Structure
------------------






+------------+------------------+------------------------+
| Field Name |       Type       |      Description       |
+============+==================+========================+
| run        | :ref:`mlflowrun` | The newly created run. |
+------------+------------------+------------------------+

===========================



.. _mlflowMlflowServicedeleteRun:

Delete Run
==========


+----------------------------+-------------+
|          Endpoint          | HTTP Method |
+============================+=============+
| ``2.0/mlflow/runs/delete`` | ``POST``    |
+----------------------------+-------------+

Mark a run for deletion.




.. _mlflowDeleteRun:

Request Structure
-----------------






+------------+------------+--------------------------+
| Field Name |    Type    |       Description        |
+============+============+==========================+
| run_id     | ``STRING`` | ID of the run to delete. |
|            |            | This field is required.  |
|            |            |                          |
+------------+------------+--------------------------+

===========================



.. _mlflowMlflowServicerestoreRun:

Restore Run
===========


+-----------------------------+-------------+
|          Endpoint           | HTTP Method |
+=============================+=============+
| ``2.0/mlflow/runs/restore`` | ``POST``    |
+-----------------------------+-------------+

Restore a deleted run.




.. _mlflowRestoreRun:

Request Structure
-----------------






+------------+------------+---------------------------+
| Field Name |    Type    |        Description        |
+============+============+===========================+
| run_id     | ``STRING`` | ID of the run to restore. |
|            |            | This field is required.   |
|            |            |                           |
+------------+------------+---------------------------+

===========================



.. _mlflowMlflowServicegetRun:

Get Run
=======


+-------------------------+-------------+
|        Endpoint         | HTTP Method |
+=========================+=============+
| ``2.0/mlflow/runs/get`` | ``GET``     |
+-------------------------+-------------+

Get metadata, metrics, params, and tags for a run. In the case where multiple metrics
with the same key are logged for a run, return only the value with the latest timestamp.
If there are multiple values with the latest timestamp, return the maximum of these values.




.. _mlflowGetRun:

Request Structure
-----------------






+------------+------------+--------------------------------------------------------------------------+
| Field Name |    Type    |                               Description                                |
+============+============+==========================================================================+
| run_id     | ``STRING`` | ID of the run to fetch. Must be provided.                                |
+------------+------------+--------------------------------------------------------------------------+
| run_uuid   | ``STRING`` | [Deprecated, use run_id instead] ID of the run to fetch. This field will |
|            |            | be removed in a future MLflow version.                                   |
+------------+------------+--------------------------------------------------------------------------+

.. _mlflowGetRunResponse:

Response Structure
------------------






+------------+------------------+----------------------------------------------------------------------------+
| Field Name |       Type       |                                Description                                 |
+============+==================+============================================================================+
| run        | :ref:`mlflowrun` | Run metadata (name, start time, etc) and data (metrics, params, and tags). |
+------------+------------------+----------------------------------------------------------------------------+

===========================



.. _mlflowMlflowServicelogMetric:

Log Metric
==========


+--------------------------------+-------------+
|            Endpoint            | HTTP Method |
+================================+=============+
| ``2.0/mlflow/runs/log-metric`` | ``POST``    |
+--------------------------------+-------------+

Log a metric for a run. A metric is a key-value pair (string key, float value) with an
associated timestamp. Examples include the various metrics that represent ML model accuracy.
A metric can be logged multiple times.




.. _mlflowLogMetric:

Request Structure
-----------------






+------------+------------+-----------------------------------------------------------------------------------------------+
| Field Name |    Type    |                                          Description                                          |
+============+============+===============================================================================================+
| run_id     | ``STRING`` | ID of the run under which to log the metric. Must be provided.                                |
+------------+------------+-----------------------------------------------------------------------------------------------+
| run_uuid   | ``STRING`` | [Deprecated, use run_id instead] ID of the run under which to log the metric. This field will |
|            |            | be removed in a future MLflow version.                                                        |
+------------+------------+-----------------------------------------------------------------------------------------------+
| key        | ``STRING`` | Name of the metric.                                                                           |
|            |            | This field is required.                                                                       |
|            |            |                                                                                               |
+------------+------------+-----------------------------------------------------------------------------------------------+
| value      | ``DOUBLE`` | Double value of the metric being logged.                                                      |
|            |            | This field is required.                                                                       |
|            |            |                                                                                               |
+------------+------------+-----------------------------------------------------------------------------------------------+
| timestamp  | ``INT64``  | Unix timestamp in milliseconds at the time metric was logged.                                 |
|            |            | This field is required.                                                                       |
|            |            |                                                                                               |
+------------+------------+-----------------------------------------------------------------------------------------------+
| step       | ``INT64``  | Step at which to log the metric                                                               |
+------------+------------+-----------------------------------------------------------------------------------------------+

===========================



.. _mlflowMlflowServicelogBatch:

Log Batch
=========


+-------------------------------+-------------+
|           Endpoint            | HTTP Method |
+===============================+=============+
| ``2.0/mlflow/runs/log-batch`` | ``POST``    |
+-------------------------------+-------------+

Log a batch of metrics, params, and tags for a run.
If any data failed to be persisted, the server will respond with an error (non-200 status code).
In case of error (due to internal server error or an invalid request), partial data may
be written.

You can write metrics, params, and tags in interleaving fashion, but within a given entity
type are guaranteed to follow the order specified in the request body. That is, for an API
request like

.. code-block:: json

  {
     "run_id": "2a14ed5c6a87499199e0106c3501eab8",
     "metrics": [
       {"key": "mae", "value": 2.5, "timestamp": 1552550804},
       {"key": "rmse", "value": 2.7, "timestamp": 1552550804},
     ],
     "params": [
       {"key": "model_class", "value": "LogisticRegression"},
     ]
  }

the server is guaranteed to write metric "rmse" after "mae", though it may write param
"model_class" before both metrics, after "mae", or after both metrics.

The overwrite behavior for metrics, params, and tags is as follows:

- Metrics: metric values are never overwritten. Logging a metric (key, value, timestamp) appends to the set of values for the metric with the provided key.

- Tags: tag values can be overwritten by successive writes to the same tag key. That is, if multiple tag values with the same key are provided in the same API request, the last-provided tag value is written. Logging the same tag (key, value) is permitted - that is, logging a tag is idempotent.

- Params: once written, param values cannot be changed (attempting to overwrite a param value will result in an error). However, logging the same param (key, value) is permitted - that is, logging a param is idempotent.

Request Limits
--------------
A single JSON-serialized API request may be up to 1 MB in size and contain:

- No more than 1000 metrics, params, and tags in total
- Up to 1000 metrics
- Up to 100 params
- Up to 100 tags

For example, a valid request might contain 900 metrics, 50 params, and 50 tags, but logging
900 metrics, 50 params, and 51 tags is invalid. The following limits also apply
to metric, param, and tag keys and values:

- Metric, param, and tag keys can be up to 250 characters in length
- Param and tag values can be up to 250 characters in length




.. _mlflowLogBatch:

Request Structure
-----------------






+------------+---------------------------------+---------------------------------------------------------------------------------+
| Field Name |              Type               |                                   Description                                   |
+============+=================================+=================================================================================+
| run_id     | ``STRING``                      | ID of the run to log under                                                      |
+------------+---------------------------------+---------------------------------------------------------------------------------+
| metrics    | An array of :ref:`mlflowmetric` | Metrics to log. A single request can contain up to 1000 metrics, and up to 1000 |
|            |                                 | metrics, params, and tags in total.                                             |
+------------+---------------------------------+---------------------------------------------------------------------------------+
| params     | An array of :ref:`mlflowparam`  | Params to log. A single request can contain up to 100 params, and up to 1000    |
|            |                                 | metrics, params, and tags in total.                                             |
+------------+---------------------------------+---------------------------------------------------------------------------------+
| tags       | An array of :ref:`mlflowruntag` | Tags to log. A single request can contain up to 100 tags, and up to 1000        |
|            |                                 | metrics, params, and tags in total.                                             |
+------------+---------------------------------+---------------------------------------------------------------------------------+

===========================



.. _mlflowMlflowServicelogModel:

Log Model
=========


+-------------------------------+-------------+
|           Endpoint            | HTTP Method |
+===============================+=============+
| ``2.0/mlflow/runs/log-model`` | ``POST``    |
+-------------------------------+-------------+

.. note::
    Experimental: This API may change or be removed in a future release without warning.




.. _mlflowLogModel:

Request Structure
-----------------






+------------+------------+------------------------------+
| Field Name |    Type    |         Description          |
+============+============+==============================+
| run_id     | ``STRING`` | ID of the run to log under   |
+------------+------------+------------------------------+
| model_json | ``STRING`` | MLmodel file in json format. |
+------------+------------+------------------------------+

===========================



.. _mlflowMlflowServicelogInputs:

Log Inputs
==========


+--------------------------------+-------------+
|            Endpoint            | HTTP Method |
+================================+=============+
| ``2.0/mlflow/runs/log-inputs`` | ``POST``    |
+--------------------------------+-------------+

.. note::
    Experimental: This API may change or be removed in a future release without warning.




.. _mlflowLogInputs:

Request Structure
-----------------



.. note::
    Experimental: This API may change or be removed in a future release without warning.


+------------+---------------------------------------+----------------------------+
| Field Name |                 Type                  |        Description         |
+============+=======================================+============================+
| run_id     | ``STRING``                            | ID of the run to log under |
|            |                                       | This field is required.    |
|            |                                       |                            |
+------------+---------------------------------------+----------------------------+
| datasets   | An array of :ref:`mlflowdatasetinput` | Dataset inputs             |
+------------+---------------------------------------+----------------------------+

===========================



.. _mlflowMlflowServicesetExperimentTag:

Set Experiment Tag
==================


+-----------------------------------------------+-------------+
|                   Endpoint                    | HTTP Method |
+===============================================+=============+
| ``2.0/mlflow/experiments/set-experiment-tag`` | ``POST``    |
+-----------------------------------------------+-------------+

Set a tag on an experiment. Experiment tags are metadata that can be updated.




.. _mlflowSetExperimentTag:

Request Structure
-----------------






+---------------+------------+-------------------------------------------------------------------------------------+
|  Field Name   |    Type    |                                     Description                                     |
+===============+============+=====================================================================================+
| experiment_id | ``STRING`` | ID of the experiment under which to log the tag. Must be provided.                  |
|               |            | This field is required.                                                             |
|               |            |                                                                                     |
+---------------+------------+-------------------------------------------------------------------------------------+
| key           | ``STRING`` | Name of the tag. Maximum size depends on storage backend.                           |
|               |            | All storage backends are guaranteed to support key values up to 250 bytes in size.  |
|               |            | This field is required.                                                             |
|               |            |                                                                                     |
+---------------+------------+-------------------------------------------------------------------------------------+
| value         | ``STRING`` | String value of the tag being logged. Maximum size depends on storage backend.      |
|               |            | All storage backends are guaranteed to support key values up to 5000 bytes in size. |
|               |            | This field is required.                                                             |
|               |            |                                                                                     |
+---------------+------------+-------------------------------------------------------------------------------------+

===========================



.. _mlflowMlflowServicesetTag:

Set Tag
=======


+-----------------------------+-------------+
|          Endpoint           | HTTP Method |
+=============================+=============+
| ``2.0/mlflow/runs/set-tag`` | ``POST``    |
+-----------------------------+-------------+

Set a tag on a run. Tags are run metadata that can be updated during a run and after
a run completes.




.. _mlflowSetTag:

Request Structure
-----------------






+------------+------------+--------------------------------------------------------------------------------------------+
| Field Name |    Type    |                                        Description                                         |
+============+============+============================================================================================+
| run_id     | ``STRING`` | ID of the run under which to log the tag. Must be provided.                                |
+------------+------------+--------------------------------------------------------------------------------------------+
| run_uuid   | ``STRING`` | [Deprecated, use run_id instead] ID of the run under which to log the tag. This field will |
|            |            | be removed in a future MLflow version.                                                     |
+------------+------------+--------------------------------------------------------------------------------------------+
| key        | ``STRING`` | Name of the tag. Maximum size depends on storage backend.                                  |
|            |            | All storage backends are guaranteed to support key values up to 250 bytes in size.         |
|            |            | This field is required.                                                                    |
|            |            |                                                                                            |
+------------+------------+--------------------------------------------------------------------------------------------+
| value      | ``STRING`` | String value of the tag being logged. Maximum size depends on storage backend.             |
|            |            | All storage backends are guaranteed to support key values up to 5000 bytes in size.        |
|            |            | This field is required.                                                                    |
|            |            |                                                                                            |
+------------+------------+--------------------------------------------------------------------------------------------+

===========================



.. _mlflowMlflowServicedeleteTag:

Delete Tag
==========


+--------------------------------+-------------+
|            Endpoint            | HTTP Method |
+================================+=============+
| ``2.0/mlflow/runs/delete-tag`` | ``POST``    |
+--------------------------------+-------------+

Delete a tag on a run. Tags are run metadata that can be updated during a run and after
a run completes.




.. _mlflowDeleteTag:

Request Structure
-----------------






+------------+------------+----------------------------------------------------------------+
| Field Name |    Type    |                          Description                           |
+============+============+================================================================+
| run_id     | ``STRING`` | ID of the run that the tag was logged under. Must be provided. |
|            |            | This field is required.                                        |
|            |            |                                                                |
+------------+------------+----------------------------------------------------------------+
| key        | ``STRING`` | Name of the tag. Maximum size is 255 bytes. Must be provided.  |
|            |            | This field is required.                                        |
|            |            |                                                                |
+------------+------------+----------------------------------------------------------------+

===========================



.. _mlflowMlflowServicelogParam:

Log Param
=========


+-----------------------------------+-------------+
|             Endpoint              | HTTP Method |
+===================================+=============+
| ``2.0/mlflow/runs/log-parameter`` | ``POST``    |
+-----------------------------------+-------------+

Log a param used for a run. A param is a key-value pair (string key,
string value). Examples include hyperparameters used for ML model training and
constant dates and values used in an ETL pipeline. A param can be logged only once for a run.




.. _mlflowLogParam:

Request Structure
-----------------






+------------+------------+----------------------------------------------------------------------------------------------+
| Field Name |    Type    |                                         Description                                          |
+============+============+==============================================================================================+
| run_id     | ``STRING`` | ID of the run under which to log the param. Must be provided.                                |
+------------+------------+----------------------------------------------------------------------------------------------+
| run_uuid   | ``STRING`` | [Deprecated, use run_id instead] ID of the run under which to log the param. This field will |
|            |            | be removed in a future MLflow version.                                                       |
+------------+------------+----------------------------------------------------------------------------------------------+
| key        | ``STRING`` | Name of the param. Maximum size is 255 bytes.                                                |
|            |            | This field is required.                                                                      |
|            |            |                                                                                              |
+------------+------------+----------------------------------------------------------------------------------------------+
| value      | ``STRING`` | String value of the param being logged. Maximum size is 500 bytes.                           |
|            |            | This field is required.                                                                      |
|            |            |                                                                                              |
+------------+------------+----------------------------------------------------------------------------------------------+

===========================



.. _mlflowMlflowServicegetMetricHistory:

Get Metric History
==================


+------------------------------------+-------------+
|              Endpoint              | HTTP Method |
+====================================+=============+
| ``2.0/mlflow/metrics/get-history`` | ``GET``     |
+------------------------------------+-------------+

Get a list of all values for the specified metric for a given run.




.. _mlflowGetMetricHistory:

Request Structure
-----------------






+-------------+------------+------------------------------------------------------------------------------------------------+
| Field Name  |    Type    |                                          Description                                           |
+=============+============+================================================================================================+
| run_id      | ``STRING`` | ID of the run from which to fetch metric values. Must be provided.                             |
+-------------+------------+------------------------------------------------------------------------------------------------+
| run_uuid    | ``STRING`` | [Deprecated, use run_id instead] ID of the run from which to fetch metric values. This field   |
|             |            | will be removed in a future MLflow version.                                                    |
+-------------+------------+------------------------------------------------------------------------------------------------+
| metric_key  | ``STRING`` | Name of the metric.                                                                            |
|             |            | This field is required.                                                                        |
|             |            |                                                                                                |
+-------------+------------+------------------------------------------------------------------------------------------------+
| page_token  | ``STRING`` | Token indicating the page of metric history to fetch                                           |
+-------------+------------+------------------------------------------------------------------------------------------------+
| max_results | ``INT32``  | Maximum number of logged instances of a metric for a run to return per call.                   |
|             |            | Backend servers may restrict the value of `max_results` depending on performance requirements. |
|             |            | Requests that do not specify this value will behave as non-paginated queries where all         |
|             |            | metric history values for a given metric within a run are returned in a single response.       |
+-------------+------------+------------------------------------------------------------------------------------------------+

.. _mlflowGetMetricHistoryResponse:

Response Structure
------------------






+-----------------+---------------------------------+-------------------------------------------------------------------------------------+
|   Field Name    |              Type               |                                     Description                                     |
+=================+=================================+=====================================================================================+
| metrics         | An array of :ref:`mlflowmetric` | All logged values for this metric.                                                  |
+-----------------+---------------------------------+-------------------------------------------------------------------------------------+
| next_page_token | ``STRING``                      | Token that can be used to issue a query for the next page of metric history values. |
|                 |                                 | A missing token indicates that no additional metrics are available to fetch.        |
+-----------------+---------------------------------+-------------------------------------------------------------------------------------+

===========================



.. _mlflowMlflowServicesearchRuns:

Search Runs
===========


+----------------------------+-------------+
|          Endpoint          | HTTP Method |
+============================+=============+
| ``2.0/mlflow/runs/search`` | ``POST``    |
+----------------------------+-------------+

Search for runs that satisfy expressions. Search expressions can use :ref:`mlflowMetric` and
:ref:`mlflowParam` keys.




.. _mlflowSearchRuns:

Request Structure
-----------------






+----------------+------------------------+------------------------------------------------------------------------------------------------------+
|   Field Name   |          Type          |                                             Description                                              |
+================+========================+======================================================================================================+
| experiment_ids | An array of ``STRING`` | List of experiment IDs to search over.                                                               |
+----------------+------------------------+------------------------------------------------------------------------------------------------------+
| filter         | ``STRING``             | A filter expression over params, metrics, and tags, that allows returning a subset of                |
|                |                        | runs. The syntax is a subset of SQL that supports ANDing together binary operations                  |
|                |                        | between a param, metric, or tag and a constant.                                                      |
|                |                        |                                                                                                      |
|                |                        | Example: ``metrics.rmse < 1 and params.model_class = 'LogisticRegression'``                          |
|                |                        |                                                                                                      |
|                |                        | You can select columns with special characters (hyphen, space, period, etc.) by using double quotes: |
|                |                        | ``metrics."model class" = 'LinearRegression' and tags."user-name" = 'Tomas'``                        |
|                |                        |                                                                                                      |
|                |                        | Supported operators are ``=``, ``!=``, ``>``, ``>=``, ``<``, and ``<=``.                             |
+----------------+------------------------+------------------------------------------------------------------------------------------------------+
| run_view_type  | :ref:`mlflowviewtype`  | Whether to display only active, only deleted, or all runs.                                           |
|                |                        | Defaults to only active runs.                                                                        |
+----------------+------------------------+------------------------------------------------------------------------------------------------------+
| max_results    | ``INT32``              | Maximum number of runs desired. If unspecified, defaults to 1000.                                    |
|                |                        | All servers are guaranteed to support a `max_results` threshold of at least 50,000                   |
|                |                        | but may support more. Callers of this endpoint are encouraged to pass max_results                    |
|                |                        | explicitly and leverage page_token to iterate through experiments.                                   |
+----------------+------------------------+------------------------------------------------------------------------------------------------------+
| order_by       | An array of ``STRING`` | List of columns to be ordered by, including attributes, params, metrics, and tags with an            |
|                |                        | optional "DESC" or "ASC" annotation, where "ASC" is the default.                                     |
|                |                        | Example: ["params.input DESC", "metrics.alpha ASC", "metrics.rmse"]                                  |
|                |                        | Tiebreaks are done by start_time DESC followed by run_id for runs with the same start time           |
|                |                        | (and this is the default ordering criterion if order_by is not provided).                            |
+----------------+------------------------+------------------------------------------------------------------------------------------------------+
| page_token     | ``STRING``             |                                                                                                      |
+----------------+------------------------+------------------------------------------------------------------------------------------------------+

.. _mlflowSearchRunsResponse:

Response Structure
------------------






+-----------------+------------------------------+--------------------------------------+
|   Field Name    |             Type             |             Description              |
+=================+==============================+======================================+
| runs            | An array of :ref:`mlflowrun` | Runs that match the search criteria. |
+-----------------+------------------------------+--------------------------------------+
| next_page_token | ``STRING``                   |                                      |
+-----------------+------------------------------+--------------------------------------+

===========================



.. _mlflowMlflowServicelistArtifacts:

List Artifacts
==============


+-------------------------------+-------------+
|           Endpoint            | HTTP Method |
+===============================+=============+
| ``2.0/mlflow/artifacts/list`` | ``GET``     |
+-------------------------------+-------------+

List artifacts for a run. Takes an optional ``artifact_path`` prefix which if specified,
the response contains only artifacts with the specified prefix.




.. _mlflowListArtifacts:

Request Structure
-----------------






+------------+------------+-----------------------------------------------------------------------------------------+
| Field Name |    Type    |                                       Description                                       |
+============+============+=========================================================================================+
| run_id     | ``STRING`` | ID of the run whose artifacts to list. Must be provided.                                |
+------------+------------+-----------------------------------------------------------------------------------------+
| run_uuid   | ``STRING`` | [Deprecated, use run_id instead] ID of the run whose artifacts to list. This field will |
|            |            | be removed in a future MLflow version.                                                  |
+------------+------------+-----------------------------------------------------------------------------------------+
| path       | ``STRING`` | Filter artifacts matching this path (a relative path from the root artifact directory). |
+------------+------------+-----------------------------------------------------------------------------------------+
| page_token | ``STRING`` | Token indicating the page of artifact results to fetch                                  |
+------------+------------+-----------------------------------------------------------------------------------------+

.. _mlflowListArtifactsResponse:

Response Structure
------------------






+-----------------+-----------------------------------+----------------------------------------------------------------------+
|   Field Name    |               Type                |                             Description                              |
+=================+===================================+======================================================================+
| root_uri        | ``STRING``                        | Root artifact directory for the run.                                 |
+-----------------+-----------------------------------+----------------------------------------------------------------------+
| files           | An array of :ref:`mlflowfileinfo` | File location and metadata for artifacts.                            |
+-----------------+-----------------------------------+----------------------------------------------------------------------+
| next_page_token | ``STRING``                        | Token that can be used to retrieve the next page of artifact results |
+-----------------+-----------------------------------+----------------------------------------------------------------------+

===========================



.. _mlflowMlflowServiceupdateRun:

Update Run
==========


+----------------------------+-------------+
|          Endpoint          | HTTP Method |
+============================+=============+
| ``2.0/mlflow/runs/update`` | ``POST``    |
+----------------------------+-------------+

Update run metadata.




.. _mlflowUpdateRun:

Request Structure
-----------------






+------------+------------------------+----------------------------------------------------------------------------+
| Field Name |          Type          |                                Description                                 |
+============+========================+============================================================================+
| run_id     | ``STRING``             | ID of the run to update. Must be provided.                                 |
+------------+------------------------+----------------------------------------------------------------------------+
| run_uuid   | ``STRING``             | [Deprecated, use run_id instead] ID of the run to update.. This field will |
|            |                        | be removed in a future MLflow version.                                     |
+------------+------------------------+----------------------------------------------------------------------------+
| status     | :ref:`mlflowrunstatus` | Updated status of the run.                                                 |
+------------+------------------------+----------------------------------------------------------------------------+
| end_time   | ``INT64``              | Unix timestamp in milliseconds of when the run ended.                      |
+------------+------------------------+----------------------------------------------------------------------------+
| run_name   | ``STRING``             | Updated name of the run.                                                   |
+------------+------------------------+----------------------------------------------------------------------------+

.. _mlflowUpdateRunResponse:

Response Structure
------------------






+------------+----------------------+------------------------------+
| Field Name |         Type         |         Description          |
+============+======================+==============================+
| run_info   | :ref:`mlflowruninfo` | Updated metadata of the run. |
+------------+----------------------+------------------------------+

===========================



.. _mlflowModelRegistryServicecreateRegisteredModel:

Create RegisteredModel
======================


+-----------------------------------------+-------------+
|                Endpoint                 | HTTP Method |
+=========================================+=============+
| ``2.0/mlflow/registered-models/create`` | ``POST``    |
+-----------------------------------------+-------------+

Throws ``RESOURCE_ALREADY_EXISTS`` if a registered model with the given name exists.




.. _mlflowCreateRegisteredModel:

Request Structure
-----------------






+-------------+---------------------------------------------+--------------------------------------------+
| Field Name  |                    Type                     |                Description                 |
+=============+=============================================+============================================+
| name        | ``STRING``                                  | Register models under this name            |
|             |                                             | This field is required.                    |
|             |                                             |                                            |
+-------------+---------------------------------------------+--------------------------------------------+
| tags        | An array of :ref:`mlflowregisteredmodeltag` | Additional metadata for registered model.  |
+-------------+---------------------------------------------+--------------------------------------------+
| description | ``STRING``                                  | Optional description for registered model. |
+-------------+---------------------------------------------+--------------------------------------------+

.. _mlflowCreateRegisteredModelResponse:

Response Structure
------------------






+------------------+------------------------------+-------------+
|    Field Name    |             Type             | Description |
+==================+==============================+=============+
| registered_model | :ref:`mlflowregisteredmodel` |             |
+------------------+------------------------------+-------------+

===========================



.. _mlflowModelRegistryServicegetRegisteredModel:

Get RegisteredModel
===================


+--------------------------------------+-------------+
|               Endpoint               | HTTP Method |
+======================================+=============+
| ``2.0/mlflow/registered-models/get`` | ``GET``     |
+--------------------------------------+-------------+






.. _mlflowGetRegisteredModel:

Request Structure
-----------------






+------------+------------+------------------------------------------+
| Field Name |    Type    |               Description                |
+============+============+==========================================+
| name       | ``STRING`` | Registered model unique name identifier. |
|            |            | This field is required.                  |
|            |            |                                          |
+------------+------------+------------------------------------------+

.. _mlflowGetRegisteredModelResponse:

Response Structure
------------------






+------------------+------------------------------+-------------+
|    Field Name    |             Type             | Description |
+==================+==============================+=============+
| registered_model | :ref:`mlflowregisteredmodel` |             |
+------------------+------------------------------+-------------+

===========================



.. _mlflowModelRegistryServicerenameRegisteredModel:

Rename RegisteredModel
======================


+-----------------------------------------+-------------+
|                Endpoint                 | HTTP Method |
+=========================================+=============+
| ``2.0/mlflow/registered-models/rename`` | ``POST``    |
+-----------------------------------------+-------------+






.. _mlflowRenameRegisteredModel:

Request Structure
-----------------






+------------+------------+--------------------------------------------------------------+
| Field Name |    Type    |                         Description                          |
+============+============+==============================================================+
| name       | ``STRING`` | Registered model unique name identifier.                     |
|            |            | This field is required.                                      |
|            |            |                                                              |
+------------+------------+--------------------------------------------------------------+
| new_name   | ``STRING`` | If provided, updates the name for this ``registered_model``. |
+------------+------------+--------------------------------------------------------------+

.. _mlflowRenameRegisteredModelResponse:

Response Structure
------------------






+------------------+------------------------------+-------------+
|    Field Name    |             Type             | Description |
+==================+==============================+=============+
| registered_model | :ref:`mlflowregisteredmodel` |             |
+------------------+------------------------------+-------------+

===========================



.. _mlflowModelRegistryServiceupdateRegisteredModel:

Update RegisteredModel
======================


+-----------------------------------------+-------------+
|                Endpoint                 | HTTP Method |
+=========================================+=============+
| ``2.0/mlflow/registered-models/update`` | ``PATCH``   |
+-----------------------------------------+-------------+






.. _mlflowUpdateRegisteredModel:

Request Structure
-----------------






+-------------+------------+---------------------------------------------------------------------+
| Field Name  |    Type    |                             Description                             |
+=============+============+=====================================================================+
| name        | ``STRING`` | Registered model unique name identifier.                            |
|             |            | This field is required.                                             |
|             |            |                                                                     |
+-------------+------------+---------------------------------------------------------------------+
| description | ``STRING`` | If provided, updates the description for this ``registered_model``. |
+-------------+------------+---------------------------------------------------------------------+

.. _mlflowUpdateRegisteredModelResponse:

Response Structure
------------------






+------------------+------------------------------+-------------+
|    Field Name    |             Type             | Description |
+==================+==============================+=============+
| registered_model | :ref:`mlflowregisteredmodel` |             |
+------------------+------------------------------+-------------+

===========================



.. _mlflowModelRegistryServicedeleteRegisteredModel:

Delete RegisteredModel
======================


+-----------------------------------------+-------------+
|                Endpoint                 | HTTP Method |
+=========================================+=============+
| ``2.0/mlflow/registered-models/delete`` | ``DELETE``  |
+-----------------------------------------+-------------+






.. _mlflowDeleteRegisteredModel:

Request Structure
-----------------






+------------+------------+------------------------------------------+
| Field Name |    Type    |               Description                |
+============+============+==========================================+
| name       | ``STRING`` | Registered model unique name identifier. |
|            |            | This field is required.                  |
|            |            |                                          |
+------------+------------+------------------------------------------+

===========================



.. _mlflowModelRegistryServicegetLatestVersions:

Get Latest ModelVersions
========================

.. warning:: Model Stages are deprecated and will be removed in a future major release. To learn more about this deprecation, see our `migration guide <../model-registry/index.html#migrating-from-stages>`_.

+------------------------------------------------------+-------------+
|                       Endpoint                       | HTTP Method |
+======================================================+=============+
| ``2.0/mlflow/registered-models/get-latest-versions`` | ``GET``     |
+------------------------------------------------------+-------------+






.. _mlflowGetLatestVersions:

Request Structure
-----------------






+------------+------------------------+------------------------------------------+
| Field Name |          Type          |               Description                |
+============+========================+==========================================+
| name       | ``STRING``             | Registered model unique name identifier. |
|            |                        | This field is required.                  |
|            |                        |                                          |
+------------+------------------------+------------------------------------------+
| stages     | An array of ``STRING`` | List of stages.                          |
+------------+------------------------+------------------------------------------+

.. _mlflowGetLatestVersionsResponse:

Response Structure
------------------






+----------------+---------------------------------------+--------------------------------------------------------------------------------------------------+
|   Field Name   |                 Type                  |                                           Description                                            |
+================+=======================================+==================================================================================================+
| model_versions | An array of :ref:`mlflowmodelversion` | Latest version models for each requests stage. Only return models with current ``READY`` status. |
|                |                                       | If no ``stages`` provided, returns the latest version for each stage, including ``"None"``.      |
+----------------+---------------------------------------+--------------------------------------------------------------------------------------------------+

===========================



.. _mlflowModelRegistryServicecreateModelVersion:

Create ModelVersion
===================


+--------------------------------------+-------------+
|               Endpoint               | HTTP Method |
+======================================+=============+
| ``2.0/mlflow/model-versions/create`` | ``POST``    |
+--------------------------------------+-------------+






.. _mlflowCreateModelVersion:

Request Structure
-----------------






+-------------+------------------------------------------+----------------------------------------------------------------------------------------+
| Field Name  |                   Type                   |                                      Description                                       |
+=============+==========================================+========================================================================================+
| name        | ``STRING``                               | Register model under this name                                                         |
|             |                                          | This field is required.                                                                |
|             |                                          |                                                                                        |
+-------------+------------------------------------------+----------------------------------------------------------------------------------------+
| source      | ``STRING``                               | URI indicating the location of the model artifacts.                                    |
|             |                                          | This field is required.                                                                |
|             |                                          |                                                                                        |
+-------------+------------------------------------------+----------------------------------------------------------------------------------------+
| run_id      | ``STRING``                               | MLflow run ID for correlation, if ``source`` was generated by an experiment run in     |
|             |                                          | MLflow tracking server                                                                 |
+-------------+------------------------------------------+----------------------------------------------------------------------------------------+
| tags        | An array of :ref:`mlflowmodelversiontag` | Additional metadata for model version.                                                 |
+-------------+------------------------------------------+----------------------------------------------------------------------------------------+
| run_link    | ``STRING``                               | MLflow run link - this is the exact link of the run that generated this model version, |
|             |                                          | potentially hosted at another instance of MLflow.                                      |
+-------------+------------------------------------------+----------------------------------------------------------------------------------------+
| description | ``STRING``                               | Optional description for model version.                                                |
+-------------+------------------------------------------+----------------------------------------------------------------------------------------+

.. _mlflowCreateModelVersionResponse:

Response Structure
------------------






+---------------+---------------------------+-----------------------------------------------------------------+
|  Field Name   |           Type            |                           Description                           |
+===============+===========================+=================================================================+
| model_version | :ref:`mlflowmodelversion` | Return new version number generated for this model in registry. |
+---------------+---------------------------+-----------------------------------------------------------------+

===========================



.. _mlflowModelRegistryServicegetModelVersion:

Get ModelVersion
================


+-----------------------------------+-------------+
|             Endpoint              | HTTP Method |
+===================================+=============+
| ``2.0/mlflow/model-versions/get`` | ``GET``     |
+-----------------------------------+-------------+






.. _mlflowGetModelVersion:

Request Structure
-----------------






+------------+------------+------------------------------+
| Field Name |    Type    |         Description          |
+============+============+==============================+
| name       | ``STRING`` | Name of the registered model |
|            |            | This field is required.      |
|            |            |                              |
+------------+------------+------------------------------+
| version    | ``STRING`` | Model version number         |
|            |            | This field is required.      |
|            |            |                              |
+------------+------------+------------------------------+

.. _mlflowGetModelVersionResponse:

Response Structure
------------------






+---------------+---------------------------+-------------+
|  Field Name   |           Type            | Description |
+===============+===========================+=============+
| model_version | :ref:`mlflowmodelversion` |             |
+---------------+---------------------------+-------------+

===========================



.. _mlflowModelRegistryServiceupdateModelVersion:

Update ModelVersion
===================


+--------------------------------------+-------------+
|               Endpoint               | HTTP Method |
+======================================+=============+
| ``2.0/mlflow/model-versions/update`` | ``PATCH``   |
+--------------------------------------+-------------+






.. _mlflowUpdateModelVersion:

Request Structure
-----------------






+-------------+------------+---------------------------------------------------------------------+
| Field Name  |    Type    |                             Description                             |
+=============+============+=====================================================================+
| name        | ``STRING`` | Name of the registered model                                        |
|             |            | This field is required.                                             |
|             |            |                                                                     |
+-------------+------------+---------------------------------------------------------------------+
| version     | ``STRING`` | Model version number                                                |
|             |            | This field is required.                                             |
|             |            |                                                                     |
+-------------+------------+---------------------------------------------------------------------+
| description | ``STRING`` | If provided, updates the description for this ``registered_model``. |
+-------------+------------+---------------------------------------------------------------------+

.. _mlflowUpdateModelVersionResponse:

Response Structure
------------------






+---------------+---------------------------+-----------------------------------------------------------------+
|  Field Name   |           Type            |                           Description                           |
+===============+===========================+=================================================================+
| model_version | :ref:`mlflowmodelversion` | Return new version number generated for this model in registry. |
+---------------+---------------------------+-----------------------------------------------------------------+

===========================



.. _mlflowModelRegistryServicedeleteModelVersion:

Delete ModelVersion
===================


+--------------------------------------+-------------+
|               Endpoint               | HTTP Method |
+======================================+=============+
| ``2.0/mlflow/model-versions/delete`` | ``DELETE``  |
+--------------------------------------+-------------+






.. _mlflowDeleteModelVersion:

Request Structure
-----------------






+------------+------------+------------------------------+
| Field Name |    Type    |         Description          |
+============+============+==============================+
| name       | ``STRING`` | Name of the registered model |
|            |            | This field is required.      |
|            |            |                              |
+------------+------------+------------------------------+
| version    | ``STRING`` | Model version number         |
|            |            | This field is required.      |
|            |            |                              |
+------------+------------+------------------------------+

===========================



.. _mlflowModelRegistryServicesearchModelVersions:

Search ModelVersions
====================


+--------------------------------------+-------------+
|               Endpoint               | HTTP Method |
+======================================+=============+
| ``2.0/mlflow/model-versions/search`` | ``GET``     |
+--------------------------------------+-------------+






.. _mlflowSearchModelVersions:

Request Structure
-----------------






+-------------+------------------------+----------------------------------------------------------------------------------------------+
| Field Name  |          Type          |                                         Description                                          |
+=============+========================+==============================================================================================+
| filter      | ``STRING``             | String filter condition, like "name='my-model-name'". Must be a single boolean condition,    |
|             |                        | with string values wrapped in single quotes.                                                 |
+-------------+------------------------+----------------------------------------------------------------------------------------------+
| max_results | ``INT64``              | Maximum number of models desired. Max threshold is 200K. Backends may choose a lower default |
|             |                        | value and maximum threshold.                                                                 |
+-------------+------------------------+----------------------------------------------------------------------------------------------+
| order_by    | An array of ``STRING`` | List of columns to be ordered by including model name, version, stage with an                |
|             |                        | optional "DESC" or "ASC" annotation, where "ASC" is the default.                             |
|             |                        | Tiebreaks are done by latest stage transition timestamp, followed by name ASC, followed by   |
|             |                        | version DESC.                                                                                |
+-------------+------------------------+----------------------------------------------------------------------------------------------+
| page_token  | ``STRING``             | Pagination token to go to next page based on previous search query.                          |
+-------------+------------------------+----------------------------------------------------------------------------------------------+

.. _mlflowSearchModelVersionsResponse:

Response Structure
------------------






+-----------------+---------------------------------------+----------------------------------------------------------------------------+
|   Field Name    |                 Type                  |                                Description                                 |
+=================+=======================================+============================================================================+
| model_versions  | An array of :ref:`mlflowmodelversion` | Models that match the search criteria                                      |
+-----------------+---------------------------------------+----------------------------------------------------------------------------+
| next_page_token | ``STRING``                            | Pagination token to request next page of models for the same search query. |
+-----------------+---------------------------------------+----------------------------------------------------------------------------+

===========================



.. _mlflowModelRegistryServicegetModelVersionDownloadUri:

Get Download URI For ModelVersion Artifacts
===========================================


+------------------------------------------------+-------------+
|                    Endpoint                    | HTTP Method |
+================================================+=============+
| ``2.0/mlflow/model-versions/get-download-uri`` | ``GET``     |
+------------------------------------------------+-------------+






.. _mlflowGetModelVersionDownloadUri:

Request Structure
-----------------






+------------+------------+------------------------------+
| Field Name |    Type    |         Description          |
+============+============+==============================+
| name       | ``STRING`` | Name of the registered model |
|            |            | This field is required.      |
|            |            |                              |
+------------+------------+------------------------------+
| version    | ``STRING`` | Model version number         |
|            |            | This field is required.      |
|            |            |                              |
+------------+------------+------------------------------+

.. _mlflowGetModelVersionDownloadUriResponse:

Response Structure
------------------






+--------------+------------+-------------------------------------------------------------------------+
|  Field Name  |    Type    |                               Description                               |
+==============+============+=========================================================================+
| artifact_uri | ``STRING`` | URI corresponding to where artifacts for this model version are stored. |
+--------------+------------+-------------------------------------------------------------------------+

===========================



.. _mlflowModelRegistryServicetransitionModelVersionStage:

Transition ModelVersion Stage
=============================

.. warning:: Model Stages are deprecated and will be removed in a future major release. To learn more about this deprecation, see our `migration guide <../model-registry/index.html#migrating-from-stages>`_.

+------------------------------------------------+-------------+
|                    Endpoint                    | HTTP Method |
+================================================+=============+
| ``2.0/mlflow/model-versions/transition-stage`` | ``POST``    |
+------------------------------------------------+-------------+






.. _mlflowTransitionModelVersionStage:

Request Structure
-----------------






+---------------------------+------------+-------------------------------------------------------------------------------------------+
|        Field Name         |    Type    |                                        Description                                        |
+===========================+============+===========================================================================================+
| name                      | ``STRING`` | Name of the registered model                                                              |
|                           |            | This field is required.                                                                   |
|                           |            |                                                                                           |
+---------------------------+------------+-------------------------------------------------------------------------------------------+
| version                   | ``STRING`` | Model version number                                                                      |
|                           |            | This field is required.                                                                   |
|                           |            |                                                                                           |
+---------------------------+------------+-------------------------------------------------------------------------------------------+
| stage                     | ``STRING`` | Transition `model_version` to new stage.                                                  |
|                           |            | This field is required.                                                                   |
|                           |            |                                                                                           |
+---------------------------+------------+-------------------------------------------------------------------------------------------+
| archive_existing_versions | ``BOOL``   | When transitioning a model version to a particular stage, this flag dictates whether all  |
|                           |            | existing model versions in that stage should be atomically moved to the "archived" stage. |
|                           |            | This ensures that at-most-one model version exists in the target stage.                   |
|                           |            | This field is *required* when transitioning a model versions's stage                      |
|                           |            | This field is required.                                                                   |
|                           |            |                                                                                           |
+---------------------------+------------+-------------------------------------------------------------------------------------------+

.. _mlflowTransitionModelVersionStageResponse:

Response Structure
------------------






+---------------+---------------------------+-----------------------+
|  Field Name   |           Type            |      Description      |
+===============+===========================+=======================+
| model_version | :ref:`mlflowmodelversion` | Updated model version |
+---------------+---------------------------+-----------------------+

===========================



.. _mlflowModelRegistryServicesearchRegisteredModels:

Search RegisteredModels
=======================


+-----------------------------------------+-------------+
|                Endpoint                 | HTTP Method |
+=========================================+=============+
| ``2.0/mlflow/registered-models/search`` | ``GET``     |
+-----------------------------------------+-------------+






.. _mlflowSearchRegisteredModels:

Request Structure
-----------------






+-------------+------------------------+--------------------------------------------------------------------------------------------+
| Field Name  |          Type          |                                        Description                                         |
+=============+========================+============================================================================================+
| filter      | ``STRING``             | String filter condition, like "name LIKE 'my-model-name'".                                 |
|             |                        | Interpreted in the backend automatically as "name LIKE '%my-model-name%'".                 |
|             |                        | Single boolean condition, with string values wrapped in single quotes.                     |
+-------------+------------------------+--------------------------------------------------------------------------------------------+
| max_results | ``INT64``              | Maximum number of models desired. Default is 100. Max threshold is 1000.                   |
+-------------+------------------------+--------------------------------------------------------------------------------------------+
| order_by    | An array of ``STRING`` | List of columns for ordering search results, which can include model name and last updated |
|             |                        | timestamp with an optional "DESC" or "ASC" annotation, where "ASC" is the default.         |
|             |                        | Tiebreaks are done by model name ASC.                                                      |
+-------------+------------------------+--------------------------------------------------------------------------------------------+
| page_token  | ``STRING``             | Pagination token to go to the next page based on a previous search query.                  |
+-------------+------------------------+--------------------------------------------------------------------------------------------+

.. _mlflowSearchRegisteredModelsResponse:

Response Structure
------------------






+-------------------+------------------------------------------+------------------------------------------------------+
|    Field Name     |                   Type                   |                     Description                      |
+===================+==========================================+======================================================+
| registered_models | An array of :ref:`mlflowregisteredmodel` | Registered Models that match the search criteria.    |
+-------------------+------------------------------------------+------------------------------------------------------+
| next_page_token   | ``STRING``                               | Pagination token to request the next page of models. |
+-------------------+------------------------------------------+------------------------------------------------------+

===========================



.. _mlflowModelRegistryServicesetRegisteredModelTag:

Set Registered Model Tag
========================


+------------------------------------------+-------------+
|                 Endpoint                 | HTTP Method |
+==========================================+=============+
| ``2.0/mlflow/registered-models/set-tag`` | ``POST``    |
+------------------------------------------+-------------+






.. _mlflowSetRegisteredModelTag:

Request Structure
-----------------






+------------+------------+----------------------------------------------------------------------------------------------------------+
| Field Name |    Type    |                                               Description                                                |
+============+============+==========================================================================================================+
| name       | ``STRING`` | Unique name of the model.                                                                                |
|            |            | This field is required.                                                                                  |
|            |            |                                                                                                          |
+------------+------------+----------------------------------------------------------------------------------------------------------+
| key        | ``STRING`` | Name of the tag. Maximum size depends on storage backend.                                                |
|            |            | If a tag with this name already exists, its preexisting value will be replaced by the specified `value`. |
|            |            | All storage backends are guaranteed to support key values up to 250 bytes in size.                       |
|            |            | This field is required.                                                                                  |
|            |            |                                                                                                          |
+------------+------------+----------------------------------------------------------------------------------------------------------+
| value      | ``STRING`` | String value of the tag being logged. Maximum size depends on storage backend.                           |
|            |            | This field is required.                                                                                  |
|            |            |                                                                                                          |
+------------+------------+----------------------------------------------------------------------------------------------------------+

===========================



.. _mlflowModelRegistryServicesetModelVersionTag:

Set Model Version Tag
=====================


+---------------------------------------+-------------+
|               Endpoint                | HTTP Method |
+=======================================+=============+
| ``2.0/mlflow/model-versions/set-tag`` | ``POST``    |
+---------------------------------------+-------------+






.. _mlflowSetModelVersionTag:

Request Structure
-----------------






+------------+------------+----------------------------------------------------------------------------------------------------------+
| Field Name |    Type    |                                               Description                                                |
+============+============+==========================================================================================================+
| name       | ``STRING`` | Unique name of the model.                                                                                |
|            |            | This field is required.                                                                                  |
|            |            |                                                                                                          |
+------------+------------+----------------------------------------------------------------------------------------------------------+
| version    | ``STRING`` | Model version number.                                                                                    |
|            |            | This field is required.                                                                                  |
|            |            |                                                                                                          |
+------------+------------+----------------------------------------------------------------------------------------------------------+
| key        | ``STRING`` | Name of the tag. Maximum size depends on storage backend.                                                |
|            |            | If a tag with this name already exists, its preexisting value will be replaced by the specified `value`. |
|            |            | All storage backends are guaranteed to support key values up to 250 bytes in size.                       |
|            |            | This field is required.                                                                                  |
|            |            |                                                                                                          |
+------------+------------+----------------------------------------------------------------------------------------------------------+
| value      | ``STRING`` | String value of the tag being logged. Maximum size depends on storage backend.                           |
|            |            | This field is required.                                                                                  |
|            |            |                                                                                                          |
+------------+------------+----------------------------------------------------------------------------------------------------------+

===========================



.. _mlflowModelRegistryServicedeleteRegisteredModelTag:

Delete Registered Model Tag
===========================


+---------------------------------------------+-------------+
|                  Endpoint                   | HTTP Method |
+=============================================+=============+
| ``2.0/mlflow/registered-models/delete-tag`` | ``DELETE``  |
+---------------------------------------------+-------------+






.. _mlflowDeleteRegisteredModelTag:

Request Structure
-----------------






+------------+------------+-------------------------------------------------------------------------------------------------------------------+
| Field Name |    Type    |                                                    Description                                                    |
+============+============+===================================================================================================================+
| name       | ``STRING`` | Name of the registered model that the tag was logged under.                                                       |
|            |            | This field is required.                                                                                           |
|            |            |                                                                                                                   |
+------------+------------+-------------------------------------------------------------------------------------------------------------------+
| key        | ``STRING`` | Name of the tag. The name must be an exact match; wild-card deletion is not supported. Maximum size is 250 bytes. |
|            |            | This field is required.                                                                                           |
|            |            |                                                                                                                   |
+------------+------------+-------------------------------------------------------------------------------------------------------------------+

===========================



.. _mlflowModelRegistryServicedeleteModelVersionTag:

Delete Model Version Tag
========================


+------------------------------------------+-------------+
|                 Endpoint                 | HTTP Method |
+==========================================+=============+
| ``2.0/mlflow/model-versions/delete-tag`` | ``DELETE``  |
+------------------------------------------+-------------+






.. _mlflowDeleteModelVersionTag:

Request Structure
-----------------






+------------+------------+-------------------------------------------------------------------------------------------------------------------+
| Field Name |    Type    |                                                    Description                                                    |
+============+============+===================================================================================================================+
| name       | ``STRING`` | Name of the registered model that the tag was logged under.                                                       |
|            |            | This field is required.                                                                                           |
|            |            |                                                                                                                   |
+------------+------------+-------------------------------------------------------------------------------------------------------------------+
| version    | ``STRING`` | Model version number that the tag was logged under.                                                               |
|            |            | This field is required.                                                                                           |
|            |            |                                                                                                                   |
+------------+------------+-------------------------------------------------------------------------------------------------------------------+
| key        | ``STRING`` | Name of the tag. The name must be an exact match; wild-card deletion is not supported. Maximum size is 250 bytes. |
|            |            | This field is required.                                                                                           |
|            |            |                                                                                                                   |
+------------+------------+-------------------------------------------------------------------------------------------------------------------+

===========================



.. _mlflowModelRegistryServicedeleteRegisteredModelAlias:

Delete Registered Model Alias
=============================


+----------------------------------------+-------------+
|                Endpoint                | HTTP Method |
+========================================+=============+
| ``2.0/mlflow/registered-models/alias`` | ``DELETE``  |
+----------------------------------------+-------------+






.. _mlflowDeleteRegisteredModelAlias:

Request Structure
-----------------






+------------+------------+---------------------------------------------------------------------------------------------------------------------+
| Field Name |    Type    |                                                     Description                                                     |
+============+============+=====================================================================================================================+
| name       | ``STRING`` | Name of the registered model.                                                                                       |
|            |            | This field is required.                                                                                             |
|            |            |                                                                                                                     |
+------------+------------+---------------------------------------------------------------------------------------------------------------------+
| alias      | ``STRING`` | Name of the alias. The name must be an exact match; wild-card deletion is not supported. Maximum size is 256 bytes. |
|            |            | This field is required.                                                                                             |
|            |            |                                                                                                                     |
+------------+------------+---------------------------------------------------------------------------------------------------------------------+

===========================



.. _mlflowModelRegistryServicegetModelVersionByAlias:

Get Model Version by Alias
==========================


+----------------------------------------+-------------+
|                Endpoint                | HTTP Method |
+========================================+=============+
| ``2.0/mlflow/registered-models/alias`` | ``GET``     |
+----------------------------------------+-------------+






.. _mlflowGetModelVersionByAlias:

Request Structure
-----------------






+------------+------------+-----------------------------------------------+
| Field Name |    Type    |                  Description                  |
+============+============+===============================================+
| name       | ``STRING`` | Name of the registered model.                 |
|            |            | This field is required.                       |
|            |            |                                               |
+------------+------------+-----------------------------------------------+
| alias      | ``STRING`` | Name of the alias. Maximum size is 256 bytes. |
|            |            | This field is required.                       |
|            |            |                                               |
+------------+------------+-----------------------------------------------+

.. _mlflowGetModelVersionByAliasResponse:

Response Structure
------------------






+---------------+---------------------------+-------------+
|  Field Name   |           Type            | Description |
+===============+===========================+=============+
| model_version | :ref:`mlflowmodelversion` |             |
+---------------+---------------------------+-------------+

===========================



.. _mlflowModelRegistryServicesetRegisteredModelAlias:

Set Registered Model Alias
==========================


+----------------------------------------+-------------+
|                Endpoint                | HTTP Method |
+========================================+=============+
| ``2.0/mlflow/registered-models/alias`` | ``POST``    |
+----------------------------------------+-------------+






.. _mlflowSetRegisteredModelAlias:

Request Structure
-----------------






+------------+------------+---------------------------------------------------------------------------------------------------------------+
| Field Name |    Type    |                                                  Description                                                  |
+============+============+===============================================================================================================+
| name       | ``STRING`` | Name of the registered model.                                                                                 |
|            |            | This field is required.                                                                                       |
|            |            |                                                                                                               |
+------------+------------+---------------------------------------------------------------------------------------------------------------+
| alias      | ``STRING`` | Name of the alias. Maximum size depends on storage backend.                                                   |
|            |            | If an alias with this name already exists, its preexisting value will be replaced by the specified `version`. |
|            |            | All storage backends are guaranteed to support alias name values up to 256 bytes in size.                     |
|            |            | This field is required.                                                                                       |
|            |            |                                                                                                               |
+------------+------------+---------------------------------------------------------------------------------------------------------------+
| version    | ``STRING`` | Model version number.                                                                                         |
|            |            | This field is required.                                                                                       |
|            |            |                                                                                                               |
+------------+------------+---------------------------------------------------------------------------------------------------------------+

.. _RESTadd:

Data Structures
===============



.. _mlflowDataset:

Dataset
-------



.. note::
    Experimental: This API may change or be removed in a future release without warning.

Dataset. Represents a reference to data used for training, testing, or evaluation during
the model development process.


+-------------+------------+----------------------------------------------------------------------------------------------+
| Field Name  |    Type    |                                         Description                                          |
+=============+============+==============================================================================================+
| name        | ``STRING`` | The name of the dataset. E.g. ?my.uc.table@2? ?nyc-taxi-dataset?, ?fantastic-elk-3?          |
|             |            | This field is required.                                                                      |
|             |            |                                                                                              |
+-------------+------------+----------------------------------------------------------------------------------------------+
| digest      | ``STRING`` | Dataset digest, e.g. an md5 hash of the dataset that uniquely identifies it                  |
|             |            | within datasets of the same name.                                                            |
|             |            | This field is required.                                                                      |
|             |            |                                                                                              |
+-------------+------------+----------------------------------------------------------------------------------------------+
| source_type | ``STRING`` | Source information for the dataset. Note that the source may not exactly reproduce the       |
|             |            | dataset if it was transformed / modified before use with MLflow.                             |
|             |            | This field is required.                                                                      |
|             |            |                                                                                              |
+-------------+------------+----------------------------------------------------------------------------------------------+
| source      | ``STRING`` | The type of the dataset source, e.g. ?databricks-uc-table?, ?DBFS?, ?S3?, ...                |
|             |            | This field is required.                                                                      |
|             |            |                                                                                              |
+-------------+------------+----------------------------------------------------------------------------------------------+
| schema      | ``STRING`` | The schema of the dataset. E.g., MLflow ColSpec JSON for a dataframe, MLflow TensorSpec JSON |
|             |            | for an ndarray, or another schema format.                                                    |
+-------------+------------+----------------------------------------------------------------------------------------------+
| profile     | ``STRING`` | The profile of the dataset. Summary statistics for the dataset, such as the number of rows   |
|             |            | in a table, the mean / std / mode of each column in a table, or the number of elements       |
|             |            | in an array.                                                                                 |
+-------------+------------+----------------------------------------------------------------------------------------------+

.. _mlflowDatasetInput:

DatasetInput
------------



.. note::
    Experimental: This API may change or be removed in a future release without warning.

DatasetInput. Represents a dataset and input tags.


+------------+-----------------------------------+----------------------------------------------------------------------------------+
| Field Name |               Type                |                                   Description                                    |
+============+===================================+==================================================================================+
| tags       | An array of :ref:`mlflowinputtag` | A list of tags for the dataset input, e.g. a ?context? tag with value ?training? |
+------------+-----------------------------------+----------------------------------------------------------------------------------+
| dataset    | :ref:`mlflowdataset`              | The dataset being used as a Run input.                                           |
|            |                                   | This field is required.                                                          |
|            |                                   |                                                                                  |
+------------+-----------------------------------+----------------------------------------------------------------------------------+

.. _mlflowExperiment:

Experiment
----------



Experiment


+-------------------+----------------------------------------+--------------------------------------------------------------------+
|    Field Name     |                  Type                  |                            Description                             |
+===================+========================================+====================================================================+
| experiment_id     | ``STRING``                             | Unique identifier for the experiment.                              |
+-------------------+----------------------------------------+--------------------------------------------------------------------+
| name              | ``STRING``                             | Human readable name that identifies the experiment.                |
+-------------------+----------------------------------------+--------------------------------------------------------------------+
| artifact_location | ``STRING``                             | Location where artifacts for the experiment are stored.            |
+-------------------+----------------------------------------+--------------------------------------------------------------------+
| lifecycle_stage   | ``STRING``                             | Current life cycle stage of the experiment: "active" or "deleted". |
|                   |                                        | Deleted experiments are not returned by APIs.                      |
+-------------------+----------------------------------------+--------------------------------------------------------------------+
| last_update_time  | ``INT64``                              | Last update time                                                   |
+-------------------+----------------------------------------+--------------------------------------------------------------------+
| creation_time     | ``INT64``                              | Creation time                                                      |
+-------------------+----------------------------------------+--------------------------------------------------------------------+
| tags              | An array of :ref:`mlflowexperimenttag` | Tags: Additional metadata key-value pairs.                         |
+-------------------+----------------------------------------+--------------------------------------------------------------------+

.. _mlflowExperimentTag:

ExperimentTag
-------------



Tag for an experiment.


+------------+------------+----------------+
| Field Name |    Type    |  Description   |
+============+============+================+
| key        | ``STRING`` | The tag key.   |
+------------+------------+----------------+
| value      | ``STRING`` | The tag value. |
+------------+------------+----------------+

.. _mlflowFileInfo:

FileInfo
--------






+------------+------------+---------------------------------------------------+
| Field Name |    Type    |                    Description                    |
+============+============+===================================================+
| path       | ``STRING`` | Path relative to the root artifact directory run. |
+------------+------------+---------------------------------------------------+
| is_dir     | ``BOOL``   | Whether the path is a directory.                  |
+------------+------------+---------------------------------------------------+
| file_size  | ``INT64``  | Size in bytes. Unset for directories.             |
+------------+------------+---------------------------------------------------+

.. _mlflowInputTag:

InputTag
--------



.. note::
    Experimental: This API may change or be removed in a future release without warning.

Tag for an input.


+------------+------------+-------------------------+
| Field Name |    Type    |       Description       |
+============+============+=========================+
| key        | ``STRING`` | The tag key.            |
|            |            | This field is required. |
|            |            |                         |
+------------+------------+-------------------------+
| value      | ``STRING`` | The tag value.          |
|            |            | This field is required. |
|            |            |                         |
+------------+------------+-------------------------+

.. _mlflowMetric:

Metric
------



Metric associated with a run, represented as a key-value pair.


+------------+------------+--------------------------------------------------+
| Field Name |    Type    |                   Description                    |
+============+============+==================================================+
| key        | ``STRING`` | Key identifying this metric.                     |
+------------+------------+--------------------------------------------------+
| value      | ``DOUBLE`` | Value associated with this metric.               |
+------------+------------+--------------------------------------------------+
| timestamp  | ``INT64``  | The timestamp at which this metric was recorded. |
+------------+------------+--------------------------------------------------+
| step       | ``INT64``  | Step at which to log the metric.                 |
+------------+------------+--------------------------------------------------+

.. _mlflowModelVersion:

ModelVersion
------------






+------------------------+------------------------------------------+----------------------------------------------------------------------------------------------------------------+
|       Field Name       |                   Type                   |                                                  Description                                                   |
+========================+==========================================+================================================================================================================+
| name                   | ``STRING``                               | Unique name of the model                                                                                       |
+------------------------+------------------------------------------+----------------------------------------------------------------------------------------------------------------+
| version                | ``STRING``                               | Model's version number.                                                                                        |
+------------------------+------------------------------------------+----------------------------------------------------------------------------------------------------------------+
| creation_timestamp     | ``INT64``                                | Timestamp recorded when this ``model_version`` was created.                                                    |
+------------------------+------------------------------------------+----------------------------------------------------------------------------------------------------------------+
| last_updated_timestamp | ``INT64``                                | Timestamp recorded when metadata for this ``model_version`` was last updated.                                  |
+------------------------+------------------------------------------+----------------------------------------------------------------------------------------------------------------+
| user_id                | ``STRING``                               | User that created this ``model_version``.                                                                      |
+------------------------+------------------------------------------+----------------------------------------------------------------------------------------------------------------+
| current_stage          | ``STRING``                               | Current stage for this ``model_version``.                                                                      |
+------------------------+------------------------------------------+----------------------------------------------------------------------------------------------------------------+
| description            | ``STRING``                               | Description of this ``model_version``.                                                                         |
+------------------------+------------------------------------------+----------------------------------------------------------------------------------------------------------------+
| source                 | ``STRING``                               | URI indicating the location of the source model artifacts, used when creating ``model_version``                |
+------------------------+------------------------------------------+----------------------------------------------------------------------------------------------------------------+
| run_id                 | ``STRING``                               | MLflow run ID used when creating ``model_version``, if ``source`` was generated by an                          |
|                        |                                          | experiment run stored in MLflow tracking server.                                                               |
+------------------------+------------------------------------------+----------------------------------------------------------------------------------------------------------------+
| status                 | :ref:`mlflowmodelversionstatus`          | Current status of ``model_version``                                                                            |
+------------------------+------------------------------------------+----------------------------------------------------------------------------------------------------------------+
| status_message         | ``STRING``                               | Details on current ``status``, if it is pending or failed.                                                     |
+------------------------+------------------------------------------+----------------------------------------------------------------------------------------------------------------+
| tags                   | An array of :ref:`mlflowmodelversiontag` | Tags: Additional metadata key-value pairs for this ``model_version``.                                          |
+------------------------+------------------------------------------+----------------------------------------------------------------------------------------------------------------+
| run_link               | ``STRING``                               | Run Link: Direct link to the run that generated this version. This field is set at model version creation time |
|                        |                                          | only for model versions whose source run is from a tracking server that is different from the registry server. |
+------------------------+------------------------------------------+----------------------------------------------------------------------------------------------------------------+
| aliases                | An array of ``STRING``                   | Aliases pointing to this ``model_version``.                                                                    |
+------------------------+------------------------------------------+----------------------------------------------------------------------------------------------------------------+

.. _mlflowModelVersionTag:

ModelVersionTag
---------------



Tag for a model version.


+------------+------------+----------------+
| Field Name |    Type    |  Description   |
+============+============+================+
| key        | ``STRING`` | The tag key.   |
+------------+------------+----------------+
| value      | ``STRING`` | The tag value. |
+------------+------------+----------------+

.. _mlflowParam:

Param
-----



Param associated with a run.


+------------+------------+-----------------------------------+
| Field Name |    Type    |            Description            |
+============+============+===================================+
| key        | ``STRING`` | Key identifying this param.       |
+------------+------------+-----------------------------------+
| value      | ``STRING`` | Value associated with this param. |
+------------+------------+-----------------------------------+

.. _mlflowRegisteredModel:

RegisteredModel
---------------






+------------------------+-----------------------------------------------+----------------------------------------------------------------------------------+
|       Field Name       |                     Type                      |                                   Description                                    |
+========================+===============================================+==================================================================================+
| name                   | ``STRING``                                    | Unique name for the model.                                                       |
+------------------------+-----------------------------------------------+----------------------------------------------------------------------------------+
| creation_timestamp     | ``INT64``                                     | Timestamp recorded when this ``registered_model`` was created.                   |
+------------------------+-----------------------------------------------+----------------------------------------------------------------------------------+
| last_updated_timestamp | ``INT64``                                     | Timestamp recorded when metadata for this ``registered_model`` was last updated. |
+------------------------+-----------------------------------------------+----------------------------------------------------------------------------------+
| user_id                | ``STRING``                                    | User that created this ``registered_model``                                      |
|                        |                                               | NOTE: this field is not currently returned.                                      |
+------------------------+-----------------------------------------------+----------------------------------------------------------------------------------+
| description            | ``STRING``                                    | Description of this ``registered_model``.                                        |
+------------------------+-----------------------------------------------+----------------------------------------------------------------------------------+
| latest_versions        | An array of :ref:`mlflowmodelversion`         | Collection of latest model versions for each stage.                              |
|                        |                                               | Only contains models with current ``READY`` status.                              |
+------------------------+-----------------------------------------------+----------------------------------------------------------------------------------+
| tags                   | An array of :ref:`mlflowregisteredmodeltag`   | Tags: Additional metadata key-value pairs for this ``registered_model``.         |
+------------------------+-----------------------------------------------+----------------------------------------------------------------------------------+
| aliases                | An array of :ref:`mlflowregisteredmodelalias` | Aliases pointing to model versions associated with this ``registered_model``.    |
+------------------------+-----------------------------------------------+----------------------------------------------------------------------------------+

.. _mlflowRegisteredModelAlias:

RegisteredModelAlias
--------------------



Alias for a registered model


+------------+------------+----------------------------------------------------+
| Field Name |    Type    |                    Description                     |
+============+============+====================================================+
| alias      | ``STRING`` | The name of the alias.                             |
+------------+------------+----------------------------------------------------+
| version    | ``STRING`` | The model version number that the alias points to. |
+------------+------------+----------------------------------------------------+

.. _mlflowRegisteredModelTag:

RegisteredModelTag
------------------



Tag for a registered model


+------------+------------+----------------+
| Field Name |    Type    |  Description   |
+============+============+================+
| key        | ``STRING`` | The tag key.   |
+------------+------------+----------------+
| value      | ``STRING`` | The tag value. |
+------------+------------+----------------+

.. _mlflowRun:

Run
---



A single run.


+------------+------------------------+---------------+
| Field Name |          Type          |  Description  |
+============+========================+===============+
| info       | :ref:`mlflowruninfo`   | Run metadata. |
+------------+------------------------+---------------+
| data       | :ref:`mlflowrundata`   | Run data.     |
+------------+------------------------+---------------+
| inputs     | :ref:`mlflowruninputs` | Run inputs.   |
+------------+------------------------+---------------+

.. _mlflowRunData:

RunData
-------



Run data (metrics, params, and tags).


+------------+---------------------------------+--------------------------------------+
| Field Name |              Type               |             Description              |
+============+=================================+======================================+
| metrics    | An array of :ref:`mlflowmetric` | Run metrics.                         |
+------------+---------------------------------+--------------------------------------+
| params     | An array of :ref:`mlflowparam`  | Run parameters.                      |
+------------+---------------------------------+--------------------------------------+
| tags       | An array of :ref:`mlflowruntag` | Additional metadata key-value pairs. |
+------------+---------------------------------+--------------------------------------+

.. _mlflowRunInfo:

RunInfo
-------



Metadata of a single run.


+-----------------+------------------------+----------------------------------------------------------------------------------+
|   Field Name    |          Type          |                                   Description                                    |
+=================+========================+==================================================================================+
| run_id          | ``STRING``             | Unique identifier for the run.                                                   |
+-----------------+------------------------+----------------------------------------------------------------------------------+
| run_uuid        | ``STRING``             | [Deprecated, use run_id instead] Unique identifier for the run. This field will  |
|                 |                        | be removed in a future MLflow version.                                           |
+-----------------+------------------------+----------------------------------------------------------------------------------+
| run_name        | ``STRING``             | The name of the run.                                                             |
+-----------------+------------------------+----------------------------------------------------------------------------------+
| experiment_id   | ``STRING``             | The experiment ID.                                                               |
+-----------------+------------------------+----------------------------------------------------------------------------------+
| user_id         | ``STRING``             | User who initiated the run.                                                      |
|                 |                        | This field is deprecated as of MLflow 1.0, and will be removed in a future       |
|                 |                        | MLflow release. Use 'mlflow.user' tag instead.                                   |
+-----------------+------------------------+----------------------------------------------------------------------------------+
| status          | :ref:`mlflowrunstatus` | Current status of the run.                                                       |
+-----------------+------------------------+----------------------------------------------------------------------------------+
| start_time      | ``INT64``              | Unix timestamp of when the run started in milliseconds.                          |
+-----------------+------------------------+----------------------------------------------------------------------------------+
| end_time        | ``INT64``              | Unix timestamp of when the run ended in milliseconds.                            |
+-----------------+------------------------+----------------------------------------------------------------------------------+
| artifact_uri    | ``STRING``             | URI of the directory where artifacts should be uploaded.                         |
|                 |                        | This can be a local path (starting with "/"), or a distributed file system (DFS) |
|                 |                        | path, like ``s3://bucket/directory`` or ``dbfs:/my/directory``.                  |
|                 |                        | If not set, the local ``./mlruns`` directory is  chosen.                         |
+-----------------+------------------------+----------------------------------------------------------------------------------+
| lifecycle_stage | ``STRING``             | Current life cycle stage of the experiment : OneOf("active", "deleted")          |
+-----------------+------------------------+----------------------------------------------------------------------------------+

.. _mlflowRunInputs:

RunInputs
---------



.. note::
    Experimental: This API may change or be removed in a future release without warning.

Run inputs.


+----------------+---------------------------------------+----------------------------+
|   Field Name   |                 Type                  |        Description         |
+================+=======================================+============================+
| dataset_inputs | An array of :ref:`mlflowdatasetinput` | Dataset inputs to the Run. |
+----------------+---------------------------------------+----------------------------+

.. _mlflowRunTag:

RunTag
------



Tag for a run.


+------------+------------+----------------+
| Field Name |    Type    |  Description   |
+============+============+================+
| key        | ``STRING`` | The tag key.   |
+------------+------------+----------------+
| value      | ``STRING`` | The tag value. |
+------------+------------+----------------+

.. _mlflowModelVersionStatus:

ModelVersionStatus
------------------




+----------------------+-----------------------------------------------------------------------------------------+
|         Name         |                                       Description                                       |
+======================+=========================================================================================+
| PENDING_REGISTRATION | Request to register a new model version is pending as server performs background tasks. |
+----------------------+-----------------------------------------------------------------------------------------+
| FAILED_REGISTRATION  | Request to register a new model version has failed.                                     |
+----------------------+-----------------------------------------------------------------------------------------+
| READY                | Model version is ready for use.                                                         |
+----------------------+-----------------------------------------------------------------------------------------+

.. _mlflowRunStatus:

RunStatus
---------


Status of a run.

+-----------+------------------------------------------+
|   Name    |               Description                |
+===========+==========================================+
| RUNNING   | Run has been initiated.                  |
+-----------+------------------------------------------+
| SCHEDULED | Run is scheduled to run at a later time. |
+-----------+------------------------------------------+
| FINISHED  | Run has completed.                       |
+-----------+------------------------------------------+
| FAILED    | Run execution failed.                    |
+-----------+------------------------------------------+
| KILLED    | Run killed by user.                      |
+-----------+------------------------------------------+

.. _mlflowViewType:

ViewType
--------


View type for ListExperiments query.

+--------------+------------------------------------------+
|     Name     |               Description                |
+==============+==========================================+
| ACTIVE_ONLY  | Default. Return only active experiments. |
+--------------+------------------------------------------+
| DELETED_ONLY | Return only deleted experiments.         |
+--------------+------------------------------------------+
| ALL          | Get all experiments.                     |
+--------------+------------------------------------------+
