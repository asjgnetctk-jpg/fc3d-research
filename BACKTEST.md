# 本地公式回测器

这套程序在本机使用多核CPU计算，不调用GPT或任何收费API。开奖号只从仓库中的已校验历史文件读取。

## 快速运行

```powershell
npm run backtest -- --size 7 --samples 100000 --workers 8
```

增加数量只需修改 `--samples`：

```powershell
npm run backtest -- --size 7 --samples 1000000 --workers 8 --output work/pool7-1m.json
```

参数：

- `--size`：5、6、7或8码。
- `--samples`：本次测试多少组公式。
- `--workers`：并行线程数，建议设为CPU逻辑核心数减1。
- `--mode random`：固定种子的无重复抽样，默认方式。
- `--mode exhaustive --start 0`：从指定序号开始顺序穷举，方便分批。
- `--seed`：随机排列种子；相同种子和起点可复现。
- `--keep`：进入开发段复选的候选数量，默认100。
- `--output`：报告保存位置。

默认严格分三段：2019-09-05至2024-09-04搜索，2024-09-05至2025-09-04复选，2025-09-05以后只检验一次。报告同时记录数据SHA-256、日期范围、候选参数和实际成绩。

若要分批继续，可保持相同 `--seed`，把下一批的 `--start` 设置成上一批的 `start + samples`。不同批次报告不能根据最终测试成绩反选；应先按开发段确定合并规则，再统一检验。
