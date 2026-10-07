import Link from "next/link";
import { BackButton } from "../../../back-button";

export function SupportZhHans({ path }: { path: (p: string) => string }) {
  return (
    <div className="wrap medium legal">
      <div className="page-title-row">
        <BackButton />
        <h1 className="serif">帮助</h1>
      </div>
      <div className="sub">最后更新：2026年9月28日</div>

      <h2>联系我们</h2>
      <p>
        欢迎把问题、错误报告以及识别出错的乐谱发送到{" "}
        <a href="mailto:bettermusicsheet@gmail.com">bettermusicsheet@gmail.com</a>
        。请注明你使用的浏览器；如果乐谱识别得不好，请附上该乐谱。
      </p>

      <h2>免费版与高级版</h2>
      <p>
        免费账号一次保留一份乐谱（要上传另一份，请先删除现有的那份），练习模式只播放乐谱的前两行。
        高级版可以保留任意数量的乐谱，并解锁完整的练习模式。
      </p>

      <h2>管理或取消订阅</h2>
      <p>
        在<Link href={path("/subscription")}>订阅页面</Link>更改套餐或取消订阅。取消后，高级版会保留到你已付费周期结束。
      </p>

      <h2>付款后没有显示高级版</h2>
      <p>订阅属于购买它的账号，请确认你登录的是那个账号，然后刷新页面。如果仍然没有显示，请给我们发邮件。</p>

      <h2>获得最佳效果</h2>
      <p>
        尽量上传 PDF：从 PDF 读取音名比从照片可靠得多，有些照片甚至完全无法识别。如果是照片，请把乐谱平放在均匀的光线下，
        并让它占满画面。音名是自动识别的，请对照原谱检查；你可以在乐谱页面上更正音名。
      </p>

      <h2>删除你的数据</h2>
      <p>
        在<Link href={path("/history")}>乐谱库</Link>中删除乐谱。要删除账号，请在页面顶部你的名字下方的菜单中选择“删除账号”。
        删除账号不会取消订阅，所以请先取消订阅。<Link href={path("/privacy")}>隐私政策</Link>说明了我们保留哪些内容，
        以及如何申请删除其他任何内容。
      </p>

      <p>
        另请参阅<Link href={path("/terms")}>使用条款</Link>。
      </p>
    </div>
  );
}
