.. _python-api:

Python API
==========

The MLflow Python API is organized into the following modules. The most common functions are
exposed in the :py:mod:`mlflow` module, so we recommend starting there.

Deeplore 定制接入见 :doc:`deeplore_core`, 包含 Python 函数签名, 参数, 返回值和使用示例.
数据集发布, Evaluation 和 Benchmark 的 HTTP 契约见 :ref:`deeplore-rest-api`.
这些客户端函数来自独立的 ``deeplore-core`` 包, 不属于官方 ``mlflow`` 命名空间.

.. toctree::
  :glob:
  :maxdepth: 1

  *


See also the :ref:`index of all functions and classes<genindex>`.

Log Levels
----------

MLflow Python APIs log information during execution using the Python Logging API. You can 
configure the log level for MLflow logs using the following code snippet. Learn more about Python
log levels at the
`Python language logging guide <https://docs.python.org/3/howto/logging.html>`_.

.. code-block:: python

    import logging

    logger = logging.getLogger("mlflow")

    # Set log level to debugging
    logger.setLevel(logging.DEBUG)
