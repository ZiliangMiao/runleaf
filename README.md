# MLflow System Design

# MLflow Dataset (非原生)

定义: 区别于原生mlflow dataset, 我们定义的dataset意在打通mlflow, dvc, git三方工具, 允许用户在GUI内完成数据集发布与版本管理. 同时支持在创建mlflow run时校验训练集和验证集的版本, 并在产生mlflow evaluation时完成对测试集的版本校验.

责任: dvc远端保存数据本体; git保存`.dvc`指针和`metadata.yaml`, 并用tag定位每个版本; mlflow dataset的登记记录是数据集版本发布状态和各samples集合hash的权威基准. 数据集发布以完成mlflow dataset登记为准, 版本校验以mlflow dataset登记的hash为准.

## DVC原理

Data version control, dvc的核心思路是**git和dvc两条平行的pipeline, git只管.dvc指针文件, dvc管数据本身**. `dvc add`给原始数据生成hash摘要 (md5算法), 生成.dvc文件, 将原始数据路径写入.gitignore, 避免数据本体进入git, 同时将数据进行缓存. 通过git提交中dvc文件记录的md5来定位数据. dvc remote仓库会对本地缓存进行备份.

![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=YWEwMjlkNmNlMWI0NjQ0ZWIxMTkyNGM5ZWJlYjk4ODdfY2I1NTQ5N2EzNzBiYTVkMDgyZGU4MGQzYTZhZTY3OTlfSUQ6NzY5MzQ1OTQ2Nzc1Njg2NjU0N18xNzkxMzg3MDEwOjE3OTE0NzM0MTBfVjM)

.dvc文件内容:

```yaml
outs:
- md5: 5d9288ee17489a3faaeeab4e48c6946b.dir  # .dir表示hash指向的是一个目录而非文件.
  size: 169042223                            # 目录中所有文件的总字节数.
  nfiles: 4                                  # 目录中的文件总数, 递归统计.
  hash: md5                                  # 所用的hash算法.
  path: annotations                          # 被追踪目录的路径, 相对于.dvc文件所在的目录.
```

## 数据集版本号

SemVer (Semantic Versioning) 版本号定义为vX.Y.Z, [参考](https://semver.org/). X表示Major, 主版本号, 不兼容的API修改; Y表示Minor, 次版本号, 向下兼容的功能性新增; Z表示Patch, 修订号, 向下兼容的问题修正. 数据集版本号基于这一原则, 制定独立的版本约定:

|**位**|**含义**|**典型变化**|
|---|---|---|
|X / Major|数据语义或对外使用约定发生不向下兼容的变化.|类别含义或索引映射变化;<br>标注属性含义或规则变化;<br>文件结构或读取接口变化导致已有读取方式失效;<br>删除原先已有的集合;<br>将历史版本train/val集合中的样本移入test集合 (历史训练使用的样本进入test, 导致可比性变化).|
|Y / Minor|在既有语义和使用约定下调整数据组成.|增加/删除样本;<br>引入新来源的样本;<br>重新划分train/val集合, 或调整test集合但不引入历史train/val集合中的样本;<br>新增其他可选集合.|
|Z / Patch|在既有语义和规则下修正错误.|修正个别样本的标注错误;<br>修正文件路径错误.|

升位规则: X增加时, Y/Z归零; Y增加时, Z归零. 如果同个发布包含多种变化, 采用最高级别版本号.

版本变化: 版本号属于整个数据集, hash属于各个集合. 每次发布版本号必须改变, 但没有改动的samples集合hash不变, 判断一个samples集合是否变化以hash为准. 版本线性演进, 新版本必须是最新已发布版本的直接后继, 首次发布固定为v1.0.0.

## 数据集结构

1. 数据集必须与相关处理脚本一起构建git仓库, 便于同步追踪数据和相关处理脚本, 数据标注的版本变化.

2. 数据集储存路径为`<project root>/data/<name>`文件夹, 文件结构如下:

    ```text
    <name>/
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
    ```

    |**目录**|**定义**|**要求**|
    |---|---|---|
    |metadata.yaml|数据集的元数据.|具体字段见版本发布流程第4步. `name`, `source`, `metrics`由创建流程写入, 其中`name`不可修改, `source`和`metrics`可以在yaml文件中人工修改, 随下一次发布生效. `version`, `hashes`, `changelog`只由发布流程写入, 禁止人工修改. 发布时整个文件作为快照登记到mlflow dataset.|
    |assets/|原始数据, 以及对原始数据处理后需要保存的数据.|对子文件夹命名和结构不做要求, 可以是images, videos, frames, crops, etc. 只要保持命名简洁无歧义, 文件夹之间的界限清晰即可. 如果全部数据都嵌入samples, 允许assets为空.|
    |assets.dvc|用dvc对assets目录计算hash, 默认使用md5算法.|无要求, dvc自动生成.|
    |annotations/|汇总用于训练或评估的samples之前的标注原始数据, 或标注数据处理产生的中间文件. 无效图片的判定清单也保存在此目录. 对于既无标注也无无效图片判定的数据集, 允许不存在annotations/及其dvc文件.|对子文件夹命名及结构不做要求. 可以与assets原始数据一一对应保存标注文件, 也可以合并文件, 或创建子文件夹分项保存. 无效图片及其已有标注的保留规则见下文.|
    |annotations.dvc|annotations目录的dvc文件.|无要求, dvc自动生成.|
    |samples/|合并后的供训练或评估用的完整样本集合. 可选包含train set, validation set, test set, 可以表示完整数据集, 也可以表示只用于训练, 验证, 或只用于评估的数据集.|样本文件和`_reference.json`必须由build脚本生成, 禁止人工修改. build脚本输入可以包含assets和按需存在的annotations. 生成结果应保持确定性, 不写入构建时间或整体数据集版本号等与样本内容无关的信息.<br>样本文件引用`samples/`外部的文件时, 一律写相对数据集根目录的路径, 以`assets/`或`annotations/`开头, 禁止绝对路径和跨数据集引用.<br>train, val, test之间不得引用相同的文件.|
    |samples/train/|可选. train set, 用于训练的完整样本集合.|如果用单个json文件, 则命名为`data.json`, 如果因为文件规模等原因, 需要拆分子json文件, 则使用`shard_000000.json`格式命名, 分片编号0填充, 不限制位数, [参考](https://huggingface.co/docs/hub/datasets-file-names-and-splits).<br>每个集合必须包含`_reference.json`, 用于记录读取该集合样本时, 还需要额外读取的samples目录外部文件, 以及每个文件的hash摘要. `files`写相对数据集根目录的路径, 必须与样本文件中出现的外部路径完全一致. 结构如下:<br>`{"hash": "md5", "files": {"assets/images/image-0001.jpg": "<file hash>", "annotations/masks/image-0001.mask.jpg": "<file hash>"}}`<br>没有外部文件读取依赖时, 保留`"files": {}`即可.|
    |samples/train.dvc|可选. train set的dvc文件, hash摘要.|无要求, dvc自动生成.|
    |samples/val/|可选. validation set, 用于验证和最佳checkpoint选择的样本集合.|同train.|
    |samples/val.dvc|可选. validation set的dvc文件, hash摘要.|无要求, dvc自动生成.|
    |samples/test/|可选. test set, 作为benchmark, 用于模型评估的样本集合.|同train.|
    |samples/test.dvc|可选. test set的dvc文件, hash摘要.|无要求, dvc自动生成.|

### 无效图片保留与样本排除

1. `assets/images/`保留属于该数据集的原始图片, 包括有效和无效图片. 已有逐图标注保留在`annotations/`的对应目录, 如`annotations/jsons/`或`annotations/images/`. 无效判定不应通过删除原图或标注来表达, 也不应将无效数据长期存放在`backup/`. 无标注的无效图片只登记判定, 不补造标注.

2. `annotations/invalid_registry.json`是无效图片判定的权威清单, 格式为`{相对图片目录: {完整文件名: 判定原因}}`. 目录相对于`assets/images/`, 图片直接位于该目录时使用`"."`. 必须保留完整相对路径和扩展名, 不得只按文件名匹配. 例如:

    ```json
    {
      "Heniochus monoceros": {
        "569346432.jpeg": "human_invalid"
      }
    }
    ```

3. **所有构建samples的脚本必须读取无效清单, 在验证和合并逐图标注之前显式排除对应图片.** 图片即使存在完整标注, 也不得进入任何samples集合. 从旧samples恢复集合成员时, 必须同步扣除无效图片, 不能依赖图片被移走或标注缺失来间接排除. 没有无效判定时可以省略清单; 清单存在但格式错误时必须报错, 禁止忽略后继续构建.

4. 无效图片及其相关标注不得出现在生成的samples中, `_reference.json`也不得引用被排除的图片. 无效清单作为构建输入随`annotations/`保存, 不因构建时读取而自动成为samples的运行时外部文件依赖. 原图和原始标注保持不变.

5. 从backup迁回无效数据时, 根据数据集归属恢复原始相对路径, 图片和已有逐图标注作为一对处理. 迁移前后校验文件内容, 同路径同内容的副本可以合并, 内容冲突必须保留并核查, 禁止覆盖. 同一无效图片的不同历史标注保存在`annotations/invalid_history/`, 按其原backup相对路径区分来源, 不参与逐图标注合并. backup中的完整历史快照和其他有效数据不按无效图片迁移.

6. 无效图片, 已有标注和无效清单分别随`assets/`与`annotations/`参与数据版本控制 (Data Version Control, DVC) 入库和数据集版本发布. 先通过构建验证, 确认所有samples均不含无效图片; `.dvc`指针和版本元数据仍由正常发布流程更新, 不手工改写.

## 数据集创建流程

在mlflow dataset页面点击创建新数据集:

1. 选择git仓库, 填入`name`, `source`, `metrics`. 数据集目录按约定固定为`<project root>/data/<name>`, 无需填写.

2. `name`只包含小写字母, 数字和连字符, 以字母开头, 在mlflow dataset中全局唯一 (包括已归档的数据集), 创建后不可修改.

3. 创建动作: 在mlflow dataset登记该数据集, 状态为未发布; 在工作区自动生成`data/<name>/metadata.yaml`模板, 其中`version: null`, `hashes`全部为null, `changelog: []`. 不产生git commit, 模板文件随首次发布一起提交.

4. 按数据集结构准备好数据后, 正常走版本发布流程.

5. 未发布的数据集可以直接删除 (移除目录和登记), 不受数据集删除流程限制.

## 数据集删除流程

原则: 已发布版本的登记记录, git tag和dvc远端数据是历史runs和evaluations的校验依据, 不做物理删除.

1. 删除集合: 不是独立操作, 而是一次Major版本发布.

    在工作区删除`samples/<set>/`目录, 并在发布表单的删除清单中勾选该集合, 两者必须一致. 对应的`.dvc`文件和`metadata.yaml`中该集合的hash由发布流程处理 (第3步删除`.dvc`文件, 第4步写入null), 不手工修改.

    删除清单的要求:

    - 可选项为`train`, `val`, `test`, `assets`, `annotations`, 默认为空.
    - 目录缺失但不在删除清单中: 发布校验报错, 防止没有执行`dvc pull`的工作区被误判为删除.
    - 在删除清单中但目录仍然存在, 或该目录在上一版本中并不存在: 发布校验报错.
    - 删除清单包含集合 (`train`, `val`, `test`) 时, 版本必须升Major; 只包含`assets`或`annotations`时不限制版本级别.

    历史版本中该集合仍可用, hash, git tag, dvc远端数据全部保留.

    如果test set被删除, 该数据集从新版本起不再是benchmark, 不可用于evaluation, 历史evaluations记录仍然保留.

2. 删除单个数据集版本: 不支持.

3. 删除整个数据集: 不允许彻底删除, 只允许归档. 在mlflow dataset中将数据集标记为archived, 在默认列表中隐藏, 不能再发布新版本, 不能用于训练或评估. 移除`data/<name>/`目录, 在默认分支提交一次`dataset(<name>): archive`并推送. 所有登记记录, git tag和dvc远端数据保留. 归档允许撤销: 从最新版本的tag恢复`data/<name>/`目录, 提交一次`dataset(<name>): unarchive`并推送, 取消archived标记.

## 数据集版本发布流程

发布任务由mlflow服务端在数据集git仓库的工作区内执行, 服务端需要能读写该工作区, 并具备git远端和dvc远端的推送权限. 同一个仓库同一时间只允许一个发布任务.

1. 在mlflow dataset中填写数据集版本发布信息.

    选择数据集, 填写:

    - 版本`version`: 只能从当前版本的三个直接后继 (Patch, Minor, Major) 中选择, 首次发布固定为`v1.0.0`.
    - 版本改动`change`: 单行文本.
    - 删除清单: 本次发布要删除的目录, 要求见数据集删除流程第1步, 默认为空.
    - 发布人`released_by`: 自动记录为执行发布任务的系统用户名, 无需填写.

2. 校验待发布数据. 这一步不修改任何文件. 校验结果分为error和warning: 存在error时终止发布, warning只作提示.

    版本号: 符合`vX.Y.Z`; 是最新已登记版本的直接后继; 在mlflow dataset登记记录, 本地和远端git tag中都不存在.

    发布状态: 数据集没有被归档; 该数据集的上一个版本已经完成登记.

    git状态: 位于默认分支, 且不落后于远端; 除本数据集的发布文件 (`metadata.yaml`, `.dvc`, dvc维护的`.gitignore`) 外, 已跟踪文件没有未提交的改动, 暂存区没有其他内容.

    目录: 检查各目录是否缺失并提示. 目录缺失与删除清单不一致时报error, 删除清单包含集合但版本没有升Major时报error.

    样本: 每个存在的集合都有样本文件和`_reference.json`, 使用shard分片时编号从0开始且连续.

    引用: 引用文件存在; 实际文件hash与`_reference.json`中一致; `_reference.json`的`files`与样本文件中出现的外部路径完全一致.

    样本集合互斥: train, val, test两两之间没有相同的引用文件 (路径相同或hash相同).

3. dvc入库.

    每次发布数据集版本时, 对本次发布包含且实际存在的`assets/`, `annotations/`和各`samples/<set>/`目录分别执行`dvc add`, 同步为当前版本重新构建对应的`.dvc`指针文件, 包括`assets.dvc`和`annotations.dvc`. 目录内容未变化时, 对应的hash保持不变. 对删除清单中的目录, 同步删除其`.dvc`文件和`.gitignore`中的对应条目 (`dvc remove`).

    以下示例假设五个目录都存在:

    ```text
    dvc add \
      data/inat/assets \
      data/inat/annotations \
      data/inat/samples/train \
      data/inat/samples/val \
      data/inat/samples/test
    ```

4. 登记metadata.

    校验通过且dvc正常入库后, 将`version`写入`metadata.yaml`, 将`<version>: <change>`追加`changelog`. 另外, 从各集合`.dvc`文件提取hash摘要`outs[0].md5`, 保留完整的`.dir`后缀, 写入`hashes`; 不存在的集合写入null. 写入前按数据版本校验流程第5步的算法, 对各集合目录独立计算一次hash, 必须与`.dvc`中的值相等, 否则终止并回滚. `metadata.yaml`完整示例:

    ```yaml
    name: inat
    source: https://www.inaturalist.org/
    version: v1.1.2
    hashes:
      train: "<train md5>.dir"
      val: "<val md5>.dir"
      test: null
    metrics: ["AP_agn", "AP", "AP_75", "AP_s", "AP_m", "AP_l"]
    changelog:      # append change of each dataset version
      - v1.0.0: initial in-domain test split (carved from pool by rule X)
      - v1.1.0: +320 crowd-scene frames
      - v1.1.1: fix mislabeled Abudefduf boxes
      - v1.1.2: fix ignore-region category_id convention
    ```

    `metadata.yaml`不重复登记`assets/`或`annotations/`的目录hash. 这两个目录的历史快照通过对应.dvc文件与git tag关联. 使用某个集合时, 校验该集合目录的hash, 并逐一校验其`_reference.json`所列资源的实际文件内容. 未被该集合读取的资源变化不影响校验结果.

    `metrics`是该数据集作为benchmark时, 每条evaluation必须记录的指标, 也是Benchmarks页面默认展示的指标; 没有test集合的数据集允许填`[]`. 文件中不记录数据集目录: 目录由仓库根目录和`name`按约定推出, 写入绝对路径会让`metadata.yaml`无法在其他机器上使用.

5. git入暂存区.

    仅暂存本次发布涉及的文件, 包括`metadata.yaml`, 新增/修改/删除的`.dvc`文件, dvc新增/修改的`.gitignore`. 由于dvc会通过.gitignore排除实际数据, 因此该文件也需要数据集版本发布追踪. 其他与数据集版本非直接相关的脚本不会自动纳入本次提交. 原始数据不进入git.

6. 创建git commit和tag.

    git commit类型新增`dataset`, 使用\<name\>, \<version\>, \<change\>作为传参.

    ```text
    git commit -m "dataset(<name>): release <version>, <change>"
    ```

    git tag

    ```text
    git tag -a <name>-<version> -m "<change>"
    ```

7. 先推送dvc数据, 再推送git.

    在仓库根目录执行, "-R"自动查找该目录以及子目录中的`.dvc`文件并上传对应数据.

    ```text
    dvc push -R data/<name>
    ```

    成功后, 再推送当前分支和本次tag, 不要用`git push --tags`, 会推送所有tags, 且不会更新分支. `--atomic`选项表示本次推送涉及的远端分支和tag, 要么全部更新成功, 要么全部不更新, 避免部分更新失败的中间状态.

    ```text
    git push --atomic origin HEAD refs/tags/<name>-<version>
    ```

8. 完成mlflow dataset发布.

    确认dvc上传, git分支和tag推送均成功后, 从本次tag对应的commit中的metadata.yaml中读取元数据, 并写入mlflow数据库, 同时记录git仓库, git tag, 对应git commit, 发布人和发布时间. 登记成功后, 该版本数据集发布成功.

    登记记录不可修改 (hash, commit, metadata快照). 拒绝对同一个 (name, version) 做重复登记.

9. 发布失败处理办法.

    推送前失败 (第3到6步): 完整回滚, 删除本地git tag, 撤销commit, 还原metadata, dvc指针和`.gitignore`.

    推送开始后失败 (第7, 8步): 保留现场并报错, 待手动解决后, 通过retry按钮从失败的步骤继续.

## 数据版本校验流程

核心思路: 以mlflow dataset数据集版本登记为校验基准, 对比工作区实际hash与登记hash.

1. **读取工作区数据集版本.**

    从数据集目录的`metadata.yaml`读取`name`和`version`.

2. **获取数据集版本的发布hash.**

    向mlflow dataset查询 (name, version) 的登记记录, 读取所需集合的hash. 查不到登记记录, 或数据集已归档, 即校验失败. 校验不依赖git仓库和dvc, 只需要数据集目录和mlflow服务.

3. **校验实际工作区.**

    创建run时校验该run用到的train和val集合 (可以来自多个数据集), 创建evaluation时校验test集合.

    对每个集合: 计算工作区集合目录的实际hash, 必须与登记hash一致; 再逐一计算`_reference.json`所列文件的实际hash, 必须与json中一致. 每次都对文件内容完整计算, 不用文件大小或修改时间代替.

4. **记录并启动.**

    校验通过后创建mlflow run, 并把每个集合的 (name, version, 集合名, 集合hash) 记录为该run的dataset.

    校验失败时终止, 不创建run或evaluation.

    resume training时重新校验, 集合hash必须与该run已记录的一致, 否则应创建新的run.

    运行期间约束工作区samples和其引用文件不变, 不从代码层面做约束: 有run正在读取某个数据集时, 不在同一工作区重建或发布该数据集. 后续考虑构建临时目录, 并dvc checkout来构建运行时临时目录, 不影响主工作区改动.

5. **hash算法.**

    与mlflow相关的hash都使用md5, 以32位小写十六进制表示.

    文件hash: 对文件原始字节计算md5, 不做换行符转换.

    目录hash: 递归列出目录下所有文件, 每个文件写为`{"md5": <文件md5>, "relpath": <相对该目录, 使用正斜杠的路径>}`, 按relpath排序成列表, 用`json.dumps(列表, sort_keys=True)`的默认格式序列化, 按UTF-8编码后取md5, 再加`.dir`. 这个定义与dvc 3 (`.dvc`文件中`hash: md5`) 的目录hash一致, 所以登记值可以直接取自`.dvc`文件, 校验端可以不安装dvc. 两者是否一致由发布流程第4步保证.

# MLflow Experiment

1. 定义: **experiment是指标具有可比性的runs集合**. 可比性落在benchmark的test hash上: 只有同一个benchmark, 同一个test hash上的evaluations才能比较. 版本号变化但test hash不变时仍然可比. 如果benchmark变化导致历史runs无法重新评估, 例如标签语义变化, 类别定义变化, 该数据集必须升Major版本, 历史runs不在新版本上评估. 若新旧runs之间因此不再有任何可以共同评估的benchmark, 必须新建experiment承接后续runs.

2. 命名: 格式为\<project name\>-\<experiment name\>, 以第一个连字符分隔, 所以project name不能包含连字符, experiment name可以包含. project name相同的experiments, 表示同一个模型训练项目, 共享`run_num`范围. experiment name应该与模型架构, 模型尺寸, 数据集或benchmark名称无关, 因为这些信息改变并不会影响runs的可比性.

# MLflow Run

1. 定义: **run记录一次训练设置固定的模型训练**. 每个run的超参数, 训练策略, 模型尺寸, 训练数据 (数据集name, version以及train, val集合的hash) 都需要严格固定, 任何一项变动都会产生一个新的run. **模型稀疏化, 模型量化等使模型权重产生改动的, 也是一个新的run**. Resume training由于训练设置没有发生改变, 保持在原run下继续记录即可 (resume时需要重新通过数据版本校验; LR scheduler改变, 或数据集版本改变的resume都是新的run).

2. 核心价值: 通过限制每个run保持一组固定训练设置, 结合`base_run`和`change`两个自定义tags, 显式要求**每次训练都必须有明确的训练设置改动记录, 并保持清晰的血缘追踪**.

3. Tags:

    |**Tags**|**定义**|**要求**|
    |---|---|---|
    |run_num|同一个project内, 从1开始自增的run编码, 是run在project内唯一且不可变的标识. 创建新的run时由mlflow服务端分配, 取该project历史上分配过的最大值加1. 同时启动的两个run不会拿到相同编号. 已分配的编号禁止复用.|不限制run_num位数, 从1开始自增, 可以是二位数/三位数. 加前缀r, 例如r1, r11, r111.|
    |base_run|创建新run时指定, 训练设置基于哪个历史run改动, 记录该run的run_num. 除了改动之外的其他参数应该保持一致. 不表示预训练权重来源.|填base run的run_num, 例如`r12`. base run必须属于同一个project. 没有base的起始run填`none`. 合并多个run的改动时可以填多个, 用逗号分隔, 例如`r12,r15`.|
    |change|创建新run时指定, 用最简短的数个单词表明相对base_run做了什么核心变更. 更详细的说明可以在description中体现.|数个单词, 单词之间用下划线连接. 例如`disable_mixup`, 表示禁用mixup数据增强策略.<br>起始run填`baseline`.|
    |model|模型架构和尺寸. 同一个experiment内可以修改模型结构, 因为不会破坏指标可比性.|全小写, 用下划线连接多个参数. 例如`vit_b_16`, `yolox_m`.|

    Tags中不记录evaluation dataset信息, 该数据只关联mlflow evaluations.

4. 原生属性:

    |**属性**|**定义**|**要求**|
    |---|---|---|
    |run_name|run的可读名称.|命名由tags组合而成, 格式为 [run_num]-[change]-[base_run]-[model], 各字段内部不含连字符; base_run有多个时用下划线连接, 例如`r12_r15`. run_name只用于阅读, 引用一个run时使用run_num或run_id.|
    |run_id|run的唯一标识.|UUID4, 由mlflow分配.|
    |description|对当前run的详细说明.|相对`base_run`的改动, 对`change`展开表述. 可选说明实验目标, 结果预期等.|
    |dataset|记录训练使用到的每个数据集集合: 数据集name, version, 集合名 (train, val), 集合hash.|来自数据版本校验流程, 每一项都必须对应mlflow dataset中的一条登记记录, 并可跳转到该版本.|

## MLflow Evaluation (非原生)

1. 定义: 与某个run的artifacts中一个具体模型文件关联的benchmark评估结果, 模型文件可以是.pth, .onnx, 以及各种部署模型文件. 每个mlflow run可以关联多条evaluations. 同一个run, 同一个模型文件, 同一个benchmark, 相同test hash下只保留一条evaluation, 多次运行直接覆盖 (evaluation_id不变, 其余字段更新). 模型文件被覆盖 (例如resume training产生了新的best checkpoint) 后, 原evaluation记录的model_hash不再对应当前文件, 视为过期, 需要重新评估. 过期的判定方式随Model Selection一起确定 (待定).

    |**属性**|**定义**|**要求**|
    |---|---|---|
    |evaluation_id|创建mlflow evaluation时系统自动计算的UUID.|覆盖时保持不变.|
    |evaluation_time|评估完成并提交的时间.|覆盖时更新.|
    |dataset_name|benchmark所属数据集的名称.|必须是mlflow dataset中已登记, 且没有被归档的数据集.|
    |dataset_version|benchmark所属数据集的版本.|必须是该数据集已登记, 且包含test集合的版本.|
    |dataset_hash|数据集test set的hash摘要.|必须等于登记记录中该版本的test hash. 提交前按数据版本校验流程校验test集合, 不允许跳过.|
    |model_path|被评估模型文件在该run的artifacts中的路径.|文件必须已经存在于该run的artifacts中.|
    |model_hash|被评估模型文件的hash摘要.|评估时实际加载的文件, md5必须与artifacts中该文件一致.|
    |params|dict. 该次evaluation使用的评估设置.|记录所有影响指标的设置, 例如输入尺寸, 置信度阈值, 非极大值抑制阈值, 推理后端. 同一个hash分组内参与比较的evaluations应使用相同的params.|
    |metrics|dict. 该次evaluation记录的指标.|必须包含该数据集`metrics`字段列出的全部指标, 可以多, 不能少.|

2. 展示: mlflow run页面内, overview右侧evaluations为入口, 按照dataset组织所有evaluations记录.

## Model Monitor

1. 定义: 模型训练和validation期间的指标, 只用于监控模型训练, 不负责记录模型训练结束后在不同benchmark上的评估结果, 也不负责记录系统硬件指标. 原来的runs/model metrics页面.

2. 展示: 创建`train`, `val`两个chart; `train`记录与模型变化相关的指标, 包括loss, learning rate, 训练集指标, 以及模型量化相关的指标; `val`记录模型验证相关的指标, 也包括best checkpoint随时间的变化.

## System Monitor

1. 定义: 系统指标, 用来记录一个run的模型训练期间, 硬件资源随时间的变化. 原来的runs/system metrics页面.

2. 展示: 创建`gpu`, `cpu`, `mem`三个chart; 记录`gpu_x_util`, `gpu_x_mem`, `gpu_x_power` (只记录该run训练使用到的GPU), `cpu_util`, `mem`指标随时间的变化. x为GPU物理编号.

3. 单位: `gpu_x_util`, `cpu_util`, `mem`为百分比, `gpu_x_mem`为MiB, `gpu_x_power`为W.

## Model Selection and Validation (非原生, TBD, 暂时先不处理)

Val set版本变化本身不影响跨run比较, val用于一个run内的best checkpoint选择; 如果val set版本变化, 则选择标准变了, 理论上需要重跑best checkpoint selection和全部evaluation (TBD).

还没有解决best checkpoint的记录和版本管理问题, 耦合validation set和selection strategy (TBD).

# MLflow Benchmark (非原生, TBD)

1. 定义: benchmark即为有test set的dataset, benchmark name即为dataset name, benchmark版本即为数据集version, benchmark hash即为数据集`hashes[test]`. 版本和hash不是一一对应: 连续多个版本的test hash可能相同 (只改动了train或val), 它们属于同一个hash分组, 该分组以第一次出现这个hash的版本号命名. 以benchmark和hash分组为组织形式, 将同个experiment内runs的所有evaluations进行组织, 排序和比较只在同一个hash分组内进行.

2. 展示: 基于mlflow dataset和mlflow evaluations (均为自定义模块, 非原生), 在experiments / runs右侧新增"benchmarks"页面入口, 代替当前experiment / chart view中查看benchmark指标的功能. 以类似kaggle benchmarks展示的形式对同个experiment内所有runs进行对比. benchmarks页面中可选多个不同benchmark, 同时可选benchmark版本, 选项为各hash分组的版本号 (即第一次出现该hash的版本号), 默认选中有evaluation的最新分组. 可以用`run_num`升序或者指标数值降序排序, 可以隐藏或展示一些runs, 可以有table和chart view, 可以选择用哪个benchmark metrics展示. 同一个run在同一个hash分组下有多个模型文件的evaluation时, 展示evaluation_time最新的一条, 其余在该run的evaluations页面查看.

3. 同时, 延伸出对benchmark的版本管理, 结合mlflow evaluation, 确保每个run在每个版本的benchmark上的评估结果独立保存, 确保所有run在某一个特定版本的benchmark上进行性能比较, 避免跨版本比较.

# MLflow Lineage (非原生)

1. 定义: 展示每个experiment内runs的血缘关系. 以`base_run`为边, 在同一个project内按run_num解析. base run位于同project的其他experiment时, 作为外部节点展示; base run已被删除时保留为缺失节点, 不断开血缘链.

# MLflow Artifact

|**文件**|**定义**|**要求**|
|---|---|---|
|checkpoints/|模型权重目录.|只存放本表列出的文件.|
|checkpoints/history/|训练过程中按固定间隔保存的历史权重.|文件名包含epoch, 上传后不再修改.|
|checkpoints/best_ckpt.pth|按val集合指标选出的当前最佳权重.|训练过程中会被更好的权重覆盖. 是训练类run默认的被评估模型文件.|
|checkpoints/latest_ckpt.pth|最近一次保存的权重和训练状态, 用于resume.|训练过程中持续覆盖, 不用于评估.|
|logs/|训练日志.|resume时追加, 不覆盖.|
|outputs/|训练结束后各类工具的输出, 如量化模型, 评估报告, 可视化结果.|每次运行写入新的子目录, 不覆盖. 评估指标以mlflow evaluation为准, 这里的报告文件只作留档.|
|snapshots/|创建run时的训练配置快照.|必须足以还原该run的全部训练设置, 创建后不再修改.|

# MLflow Model Registry (TBD, 暂时先不处理)

需要耦合模型发布和固件打包流程.

- **Registered Model**: mlflow models与experiments同级, 是一个有唯一稳定名称的模型容器, 而非一个具体的模型. 该容器用于组织面向同一个功能或服务的不同版本的可交付/部署模型.

- **Model Version**: 每次向同一个registered model注册模型时, mlflow会自动创建一个新的numeric model version, 并分配从1开始递增的版本数字. numeric version是model version的数字标识.

- **Model URI**: URI, uniform resource identifier, 统一资源标识符. 用于准确引用一个registered model的具体numeric version. 例如, `models:/deepdet-onnx/3`.

- **Model Tags**: 附加在model version上的键值对元数据, 追踪记录每个model version的来源.

- **Model Aliases**: 指向一个model version的可变指针, 多个alias可以指向同一个model version, 用于模型生命周期管理.

1. **使用场景**: 为每个下游任务单独创建一个registered model, 以deepdet为例, 创建`deepdet`registered model. 该registered model按顺序保存两种可能用于部署的模型, onnx和ambapb. 当下游任务完成训练并产出可交付/部署的模型时, 人工选出最佳mlflow run, 其所属的pytorch .pth best checkpoint继续作为run artifacts保存, 不单独注册为registered model. 之后将best checkpoint导出为静态onnx模型, 导出时可以手动指定将onnx模型进行model registry.

2. **稀疏化**: 涉及稀疏化或稀疏化训练时, 不需要重新创建mlflow experiment, 因为稀疏化不会影响模型可比性. 复用训练模型的experiment, 每次采用不同的稀疏化或稀疏化训练策略时, 对应创建一个新的mlflow run即可. 需要使用稀疏化模型做量化及端侧部署时, 选择最佳run, 将best checkpoint导出为onnx模型, 选择model registry, 即可在registered model下自动添加model version.

3. **量化**: 对于单个下游任务, 只应该存在两个registered model, 以deepdet为例, 应该存在deepdet-onnx和deepdet-ambapb, 分别注册onnx格式和针对amba cvflow量化后的ambapb格式的模型. 同一个pth模型的onnx版本和ambapb版本的numeric version不需要严格对应, 而是通过保存`lineage_source`字段来实现血缘关系追溯, 从ambapb指向onnx, 指向pth artifacts, 再指向mlflow run, 继续指向parent runs, 从而实现一个端侧部署模型的全链路血缘追溯.

4. **RegisteredModel**: `source`是该registered model的原模型文件, 在执行mlflow.register_model()之前必须先做mlflow.onnx.log_model(), logged model会上传到mlflow run下面, 并由mlflow自动分配model_id; `lineage_source`是我们定义的Tag, 用于追溯registered model的血缘.
