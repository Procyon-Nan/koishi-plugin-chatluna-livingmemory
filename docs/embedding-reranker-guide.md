# 配置指南：嵌入模型和重排序模型（Embedding & Reranker）

此文档的目的是指导你配置 chatluna-livingmemory 插件所需的嵌入模型和重排序模型：

- Qwen3-Embedding-8B
- Qwen3-Reranker-8B

在开始之前，确保你已经准备好了下列 Koishi 插件：

- chatluna
- chatluna-openai-like-adapter
- chatluna-livingmemory

## Step 1

本文配置的模型来源于[讯飞星辰MaaS平台](https://maas.xfyun.cn/)。因此，你需要先拥有并登录你的讯飞开放平台账号

没有账号当然也没关系，直接通过微信扫码或手机号进行注册并登录即可（放心，这并不会要求你付费）

登录完成后，你将会来到讯飞星辰MaaS平台的首页。你需要点击左侧边栏的**模型集市**以进入模型列表页面

<img width="2558" height="1243" alt="image" src="https://github.com/user-attachments/assets/e8e992b7-a6c2-4b93-a34a-d2174761ec8e" />

进入模型集市后，在搜索框中输入 "Qwen3-Embedding-8B" 并回车确认，之后点击出现的模型卡片。在此模型的具体页面中点击右上角的**API调用**

<img width="2557" height="1241" alt="image" src="https://github.com/user-attachments/assets/566940a7-b1f5-4945-b106-cd31a72750e7" />

点击后，会弹出一个新窗口，它要求你填写**模型服务API名称**以及**要授权的应用**。其中模型服务API名称可自行随意填写，要授权的应用则需要你选择一个已经创建了的应用

<img width="814" height="889" alt="image" src="https://github.com/user-attachments/assets/c4e3b18c-6918-4ccf-83f4-b71913f09d5c" />

如果你没有创建应用，此时点击前往创建新应用即可，这一步会在讯飞开放平台完成。

<img width="1559" height="964" alt="image" src="https://github.com/user-attachments/assets/f30cce20-ec60-488c-9b7e-2a145f5f20cc" />

提交后，返回讯飞星辰MaaS平台的页面，选择应用并确定。接着便会跳转到**模型服务列表**页面，在这里我们需要以下信息：

- modelId：xop3qwen8bembedding
- OpenAi接口地址：https://maas-api.cn-huabei-1.xf-yun.com/v2/embeddings
- APIKey：你的apikey

<img width="2558" height="1230" alt="image" src="https://github.com/user-attachments/assets/44830922-4088-43c5-ace3-ab3e695e6773" />

## Step 2

到此为止，我们就已经获取到了调用 Qwen3-Embedding-8B 所需的信息。类似地，你需要在**模型集市**的搜索框中搜索 "Qwen3-Reranker-8B" ，然后重复相同的配置流程

需要注意的是，两次API调用所授权的应用需要保持一致，**否则你将会得到两个不同的apiky**。尽管这也能使用，但对后续的流程并不友好。调用 Qwen3-Reranker-8B 所需的信息如下：

- modelId：xop3qwen8breranker
- OpenAi接口地址：https://maas-api.cn-huabei-1.xf-yun.com/v2/rerank
- APIKey：你的apikey（这应该与 Step 1 中 Qwen3-Embedding-8B 的APIKey保持一致）

## Step 3

现在，我们回到 Koishi 控制台，在插件配置中创建一份 chatluna-openai-like-adapter 的配置文件

在适配器配置的部分，我们需要关闭 pullModels （自动拉取模型列表），并且手动填写需要拉取的两个模型：

|      模型名称       |      模型类型       | 模型支持的能力 | 模型上下文大小 |
| :-----------------: | :-----------------: | :------------: | :------------: |
| xop3qwen8bembedding | Embeddings 嵌入模型 |   text_input   |     32000      |
| xop3qwen8breranker  | Reranker 重排序模型 |   text_input   |     32000      |

在请求设置的部分，我们需要填入刚刚获取到的 APIKey 和 OpenAi接口地址：

|  API Key   |                API 请求地址                |
| :--------: | :----------------------------------------: |
| 你的apikey | https://maas-api.cn-huabei-1.xf-yun.com/v2 |

**注意：这里的 API 请求地址只填到 "v2" 即可，不要加上最后的 embeddings 或 rerank**

之后就不需要再动其他配置了，保存并重载插件即可（如果不放心可重启一下插件）

~~当然了你可能会看到顶部显示 "适配器 xxx 加载成功，共加载了 0 个模型。" ，不必在意， Koishi 是这样的~~

## Step 4

现在回到 chatluna-livingmemory 的插件配置中，如果不出意外，embeddingModel 和 rerankModel 就可以选择使用前文所述的两个模型了

Good luck

[last edit: 2026-06-27]
