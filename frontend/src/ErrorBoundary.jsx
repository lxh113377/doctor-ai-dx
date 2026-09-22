import { Component } from 'react'

/* 渲染层兜底：单视图异常不白屏；只展示医生可理解文案，不展示堆栈或内部路径 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error) {
    console.error(error)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="card loading" role="alert">
          <p>页面内容渲染出现问题，请点击「刷新页面」重试，或返回重新选择病例。</p>
          <button className="btn primary" type="button" onClick={() => window.location.reload()}>刷新页面</button>
        </div>
      )
    }
    return this.props.children
  }
}
