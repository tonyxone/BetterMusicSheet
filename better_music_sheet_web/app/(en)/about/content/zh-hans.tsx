import Link from "next/link";
import { BackButton } from "../../../back-button";

export function AboutZhHans({ path }: { path: (p: string) => string }) {
  return (
    <div className="wrap medium legal">
      <div className="page-title-row">
        <BackButton />
        <h1 className="serif">关于</h1>
      </div>
      <div className="sub">它能做什么，又做不到什么</div>

      <p>
        读谱，就是把线上的一个点变成音名，再变成手指下的一个琴键。熟练的演奏者早已意识不到这一步，
        其他人却要在弹奏途中做算术。
      </p>
      <p>
        BetterMusicSheet 替您完成这一步。上传钢琴谱的 PDF 或照片，您会拿回同一份乐谱，每个音符都标好了音名，
        还有一个练习模式，在音符响起时于键盘上点亮它们。
      </p>

      <h2>标注的含义</h2>
      <p>
        每个符头上都标有它的音名——<code>C</code>、<code>F♯</code>、<code>B♭</code>——
        离得足够近，弹奏时一眼就能看清，又不会盖住下面的记谱。同时发声的音符会归为一组，
        所以一个和弦读起来是一个标注，而不是一摞标注。
      </p>
      <p>
        您可以在升号与降号写法之间切换；还在找中央 C 的话，可以加上八度编号；也可以按谱架的远近调整标注大小。
        除了字母音名，还可以显示为简谱数字（1 2 3）或唱名（do re mi）。
      </p>

      <h2>工作原理</h2>
      <p>
        识别使用开源光学乐谱识别（OMR）引擎{" "}
        <a href="https://github.com/Audiveris/audiveris" target="_blank" rel="noreferrer noopener">
          Audiveris
        </a>
        。它会找出谱表、谱号、调号和符头，并推算出每个音符的音高。随后网站把标注画到您的 PDF 副本上，
        并生成用于回放的时间轴。您的文件在本站自己的服务器上处理，不会发送给第三方服务。
      </p>
      <p>识别效果不佳的页面会自动以更高分辨率重新识别，这对排版密集的乐谱和照片都有帮助。</p>

      <h2>它不擅长什么</h2>
      <p>光学乐谱识别确实很难，与其事后吃惊，不如事先了解它的局限：</p>
      <ul>
        <li>
          <strong>照片</strong>可以用，但平整、光线均匀、正对拍摄的照片效果远好于斜着拍的。真正的 PDF 永远最好。
        </li>
        <li>
          <strong>手写乐谱</strong>基本无法识别。
        </li>
        <li>
          <strong>密集段落</strong>——快速跑动、密集的加线、大量装饰音——比简单的写法更容易漏掉音符。
        </li>
        <li>
          <strong>回放节奏只是近似值。</strong>读不出拍号时，时值是推测的，结果可能会逐渐偏差。
        </li>
      </ul>
      <p>在依赖结果之前，请先对照原谱检查。它是读谱的辅助工具，而不是校对员。</p>

      <h2>费用与账号</h2>
      <p>
        试用内置示例无需账号。上传您自己的乐谱需要一个账号，这样同一份乐谱在任何地方登录都能找到。
        免费账号一次保留一份乐谱，练习模式只播放前两行；高级版可以保留任意数量的乐谱，并解锁完整的练习模式。
        您的文件会如何处理，请参阅<Link href={path("/privacy")}>隐私政策</Link>。
      </p>

      <h2>联系我们</h2>
      <p>
        欢迎把更正、错误报告以及识别得不好的乐谱发送到{" "}
        <a href="mailto:bettermusicsheet@gmail.com">bettermusicsheet@gmail.com</a>
        。一份识别出错的乐谱对我们非常有帮助。
      </p>
    </div>
  );
}
