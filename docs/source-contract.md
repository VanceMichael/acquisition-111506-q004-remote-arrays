# 实验切片收件服务：合作来源契约

已授权域为`/lab/authorized.h5`，使用`X-Hdf-domain`头或`domain`查询参数传入。`GET /`取得root组，`GET /groups/{id}/links`返回链接；H5L_TYPE_HARD给出对象id及collection，软链接给出h5path，外部链接给出h5domain及h5path。路径是可重复的来源依据，不是对象唯一键；存在硬链接循环和失效软链接，外部域不在本次授权中。采集输入包括授权域、目标路径及窗口，不需要无差别下载所有数组。

`GET /datasets/{id}`给出shape、type、creationProperties、lastModified；`GET /datasets/{id}/value?select=[起行:止行,起列:止列]`取得半开窗口，保留返回的数组形状。当前支持二维简单空间、固定数值类型、含变长UTF8字符串的复合类型；未写入位置按声明fillValue保存，同时保留它作为填充的依据，不能一律转null或0。未知类型要报告不能解释，不要求HDF5二进制驱动。

此合作部署额外提供强ETag与If-Match，作为对象版本约束；不假设所有HSDS服务都有这一扩展。`startProvider({scenario:'grow'})`使后续对象/数据访问变为扩展后的形状与版本。没有版本证明时只报告实际观察范围，不宣称原子整库快照。选择窗口越界返回400，未授权域返回403。已有人工切片字段可以扩展以保存复合类型和来源位置，但不能只写成无类型的一串数字。

## 消费端如何使用这些入口

收件服务的自动采集实现位于`src/hsds.mjs`（客户端）和`src/resolve.mjs`（路径解析与窗口读取）：

- 只接受`AUTHORIZED_DOMAINS`声明的域（默认仅`/lab/authorized.h5`）。域之外的请求在访问来源前即以403拒绝，来源的403也原样归类。
- 从`GET /`的root组开始，逐段读取`/groups/{id}/links`。硬链接按`id`继续，同一`id`的多个组内路径会合并为同一对象身份，只读取一次元数据和窗口；软链接按`h5path`从同域根组继续；循环会停止并记录`link_cycle`。
- 外部链接只在`h5domain`已授权、且来源确实可读时继续；未授权、缺少`h5domain`/`h5path`或读不到都记录为缺口，不会继续猜测。
- 读取前用`GET /datasets/{id}`核对shape与type，再用`If-Match`（有ETag时）读取窗口。读取期间版本变化会重试；重试后仍不一致返回412并附观察记录。没有ETag时`version.verified=false`，只声明`observed-window`。
- 来源返回的每个JSON响应（组链接页、元数据、窗口）都作为独立依据保存，`source`中带域、请求路径和响应的ETag，收件后可通过`/api/evidence/{sha256}`回查。

格式参考：`https://github.com/HDFGroup/hsds`。这里运行的是只含虚构资料的本地合作端，不是公网生产服务；只需支持本文明确给出的范围。来源实现和样例可以阅读，自动接入应使用声明的交互入口，不把服务内部对象或预先写好的采集结论当作数据来源。原始依据、结构化内容和完整性状态应能在收件端回查；新增自动接口的名称与内部设计由开发者决定。
